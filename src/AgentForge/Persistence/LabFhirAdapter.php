<?php

/**
 * LabFhirAdapter — translates extracted LabResult rows into the
 * OpenEMR procedure_order / procedure_report / procedure_result chain
 * so they surface as FHIR Observations through existing OpenEMR
 * services (the same path SyntheaLoader uses).
 *
 * Idempotency contract (added 2026-05-10): the adapter is keyed on
 * the natural lab-row identity tuple
 *
 *     (patient_id, normalized_test_key, collection_date::DATE)
 *
 * where `normalized_test_key` prefers the LOINC code when present and
 * falls back to a normalized lowercase form of test_name. A second
 * write-through of the same lab document — or a different document
 * that happens to report the same test for the same patient on the
 * same collection date — finds the existing chart row and UPDATEs
 * value/units/range/abnormal/source-document instead of inserting a
 * duplicate. Either way an `agentforge_chart_evidence` row is
 * appended so the chart row carries a full audit trail of every
 * extraction that asserted it.
 *
 * For each LabResult row in the extracted JSON the adapter:
 *   1. Computes the dedup key.
 *   2. Calls the injected `existingResultFinder` closure. If it returns
 *      a procedure_result.id, the row is updated in place via the
 *      `resultUpdater` closure and counted as `updated`. Otherwise:
 *        a. Insert a procedure_order (date_collected = row's
 *           collection_date or document default; lab_id = the
 *           AgentForge demo procedure provider).
 *        b. Insert a procedure_order_code carrying the LOINC code
 *           (when present) and the test name.
 *        c. Insert a procedure_report linked to the order.
 *        d. Insert a procedure_result linked to the report carrying
 *           the numeric/display value, units, reference range, and
 *           abnormal flag. Counted as `inserted`.
 *   3. Records back-pointer rows in `agentforge_resource_links` for
 *      every created resource.
 *   4. Records an evidence row in `agentforge_chart_evidence` for the
 *      target procedure_result (whether new or updated).
 *
 * Per-row failure handling: a single bad row (malformed
 * collection_date, DB error mid-chain) does NOT abort the rest of the
 * document. The adapter records a `status='failed'` resource-link row
 * for the bad index, captures the error message, and proceeds with
 * the next row. The returned outcome reports successes, failures,
 * insert/update split, and per-row error messages.
 *
 * Collaborators are injected as closures so the adapter is unit-
 * testable without booting OpenEMR or hitting MySQL.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\AgentForge\Persistence;

use Closure;
use DateTimeImmutable;

final class LabFhirAdapter
{
    public const RESOURCE_PROCEDURE_ORDER  = 'procedure_order';
    public const RESOURCE_PROCEDURE_REPORT = 'procedure_report';
    public const RESOURCE_PROCEDURE_RESULT = 'procedure_result';

    /** Maps the lab-schema abnormal_flag enum to the procedure_result.abnormal column. */
    private const ABNORMAL_FLAG_MAP = [
        'N'  => 'no',
        'L'  => 'yes',
        'H'  => 'yes',
        'LL' => 'yes',
        'HH' => 'yes',
        'A'  => 'yes',
    ];

    /**
     * @param Closure(int $patientId, string $loinc, string $testName, string $collectedAt, int $labProviderId): int $orderInserter
     *        Returns the new procedure_order id. Also responsible for the
     *        accompanying procedure_order_code row.
     * @param Closure(int $orderId, string $reportedAt): int $reportInserter
     *        Returns the new procedure_report id.
     * @param Closure(int $reportId, string $loinc, string $testName, string $resultedAt, string $units, string $value, string $range, string $abnormal, string $dataType): int $resultInserter
     *        Returns the new procedure_result id.
     * @param Closure(int $extractionId, int $rowIndex, string $resourceType, int $resourceId, string $status, ?string $errorMessage): void $linkInserter
     *        Persists a back-pointer row in agentforge_resource_links.
     * @param Closure(): int $procedureProviderResolver
     *        Returns the lab_id (procedure_providers.ppid) used as the
     *        order's lab_id. Mirrors SyntheaLoader's
     *        ensureProcedureProvider/procedureProviderId pair.
     * @param Closure(int $patientId, string $dedupKey): ?int $existingResultFinder
     *        Looks up the procedure_result.id whose evidence row matches
     *        (patientId, dedupKey). Returns null when no prior chart row
     *        exists. Defaulted to "always returns null" for callers that
     *        haven't migrated yet — adapter still works, just without
     *        dedup.
     * @param Closure(int $resultId, string $units, string $value, string $range, string $abnormal, string $dataType, string $resultedAt): void $resultUpdater
     *        Updates the named procedure_result row's value/units/range/
     *        abnormal/data_type/date columns. Defaulted to a no-op for
     *        callers that haven't migrated.
     * @param Closure(int $extractionId, int $patientId, int $resultId, string $dedupKey): void $evidenceRecorder
     *        Appends a row to agentforge_chart_evidence. Defaulted to a
     *        no-op for callers that haven't migrated.
     */
    public function __construct(
        private readonly Closure $orderInserter,
        private readonly Closure $reportInserter,
        private readonly Closure $resultInserter,
        private readonly Closure $linkInserter,
        private readonly Closure $procedureProviderResolver,
        private readonly ?Closure $existingResultFinder = null,
        private readonly ?Closure $resultUpdater = null,
        private readonly ?Closure $evidenceRecorder = null,
    ) {
    }

    /**
     * Write each LabResult row in $extracted to the procedure_*
     * chain (or update the matching existing row) and record a
     * back-pointer + evidence row for each.
     *
     * @param int                  $extractionId  agentforge_document_extractions.id
     * @param int                  $patientId     OpenEMR patient pid
     * @param array<string, mixed> $extracted     Decoded LabPdfSchema payload
     *
     * @return LabWriteOutcome aggregate of per-row outcomes
     */
    public function writeThrough(int $extractionId, int $patientId, array $extracted): LabWriteOutcome
    {
        $results = $extracted['results'] ?? null;
        if (!is_array($results) || $results === []) {
            return new LabWriteOutcome(0, 0, []);
        }

        $documentDefault = self::stringOrNull($extracted['collection_date_default'] ?? null);
        $labProviderId   = ($this->procedureProviderResolver)();

        $inserted = 0;
        $updated  = 0;
        $failures = 0;
        $errors   = [];

        foreach ($results as $rowIndex => $row) {
            if (!is_int($rowIndex)) {
                $rowIndex = (int) $rowIndex;
            }
            if (!is_array($row)) {
                $failures++;
                $errors[$rowIndex] = 'row_not_object';
                $this->recordFailure($extractionId, $rowIndex, 'row_not_object');
                continue;
            }

            try {
                $action = $this->writeRow(
                    $extractionId,
                    $patientId,
                    $rowIndex,
                    self::stringKeyed($row),
                    $documentDefault,
                    $labProviderId,
                );
                if ($action === 'updated') {
                    $updated++;
                } else {
                    $inserted++;
                }
            } catch (\RuntimeException | \InvalidArgumentException | \LogicException $e) {
                $failures++;
                $errors[$rowIndex] = $e->getMessage();
                $this->recordFailure($extractionId, $rowIndex, $e->getMessage());
            }
        }

        return new LabWriteOutcome(
            successes: $inserted + $updated,
            failures: $failures,
            rowErrors: $errors,
            inserted: $inserted,
            updated: $updated,
        );
    }

    /**
     * Build the natural dedup key for a lab row. Stable across:
     *   - LOINC vs. no-LOINC (falls back to normalized test_name)
     *   - collection_date with or without time component (DATE only)
     *   - case / whitespace differences on test_name
     *
     * Format: `<patient_id>|<key>|<YYYY-MM-DD>` — short enough for a
     * VARCHAR(255) index column, opaque to callers (treat as a string).
     */
    public static function dedupKey(int $patientId, ?string $loinc, string $testName, string $collectedAt): string
    {
        $loincTrim = $loinc !== null ? trim($loinc) : '';
        $key = $loincTrim !== ''
            ? 'loinc:' . strtolower($loincTrim)
            : 'name:' . self::normalizeTestName($testName);
        $datePart = self::extractDateOnly($collectedAt);
        return sprintf('%d|%s|%s', $patientId, $key, $datePart);
    }

    /**
     * @param array<string, mixed> $row
     *
     * @return 'inserted'|'updated'
     */
    private function writeRow(
        int $extractionId,
        int $patientId,
        int $rowIndex,
        array $row,
        ?string $documentDefault,
        int $labProviderId,
    ): string {
        $testName = self::stringOrNull($row['test_name'] ?? null);
        if ($testName === null || $testName === '') {
            throw new \InvalidArgumentException('test_name missing');
        }
        $loinc       = self::stringOrNull($row['loinc_code'] ?? null) ?? '';
        $rowDate     = self::stringOrNull($row['collection_date'] ?? null);
        $collectedAt = self::formatDateTime($rowDate ?? $documentDefault);
        $value       = self::resolveValue($row);
        $units       = self::stringOrNull($row['unit'] ?? null) ?? '';
        $range       = self::resolveRange($row['reference_range'] ?? null);
        $abnormal    = self::resolveAbnormal($row['abnormal_flag'] ?? null);
        $dataType    = self::resolveDataType($row);
        $dedupKey    = self::dedupKey(
            $patientId,
            $loinc !== '' ? $loinc : null,
            $testName,
            $collectedAt,
        );

        // Fast-path: chart row already exists under this dedup key.
        // Update it in place, record a fresh evidence row, return.
        $existingResultId = $this->lookupExisting($patientId, $dedupKey);
        if ($existingResultId !== null) {
            $this->applyUpdate(
                $existingResultId,
                $units,
                $value,
                $range,
                $abnormal,
                $dataType,
                $collectedAt,
            );
            $this->recordEvidence($extractionId, $patientId, $existingResultId, $dedupKey);
            ($this->linkInserter)(
                $extractionId,
                $rowIndex,
                self::RESOURCE_PROCEDURE_RESULT,
                $existingResultId,
                'written',
                null,
            );
            return 'updated';
        }

        $orderId = ($this->orderInserter)(
            $patientId,
            $loinc,
            $testName,
            $collectedAt,
            $labProviderId,
        );
        ($this->linkInserter)(
            $extractionId,
            $rowIndex,
            self::RESOURCE_PROCEDURE_ORDER,
            $orderId,
            'written',
            null,
        );

        $reportId = ($this->reportInserter)($orderId, $collectedAt);
        ($this->linkInserter)(
            $extractionId,
            $rowIndex,
            self::RESOURCE_PROCEDURE_REPORT,
            $reportId,
            'written',
            null,
        );

        $resultId = ($this->resultInserter)(
            $reportId,
            $loinc,
            $testName,
            $collectedAt,
            $units,
            $value,
            $range,
            $abnormal,
            $dataType,
        );
        ($this->linkInserter)(
            $extractionId,
            $rowIndex,
            self::RESOURCE_PROCEDURE_RESULT,
            $resultId,
            'written',
            null,
        );
        $this->recordEvidence($extractionId, $patientId, $resultId, $dedupKey);
        return 'inserted';
    }

    private function lookupExisting(int $patientId, string $dedupKey): ?int
    {
        if ($this->existingResultFinder === null) {
            return null;
        }
        $result = ($this->existingResultFinder)($patientId, $dedupKey);
        return is_int($result) && $result > 0 ? $result : null;
    }

    private function applyUpdate(
        int $resultId,
        string $units,
        string $value,
        string $range,
        string $abnormal,
        string $dataType,
        string $resultedAt,
    ): void {
        if ($this->resultUpdater === null) {
            return;
        }
        ($this->resultUpdater)($resultId, $units, $value, $range, $abnormal, $dataType, $resultedAt);
    }

    private function recordEvidence(int $extractionId, int $patientId, int $resultId, string $dedupKey): void
    {
        if ($this->evidenceRecorder === null) {
            return;
        }
        ($this->evidenceRecorder)($extractionId, $patientId, $resultId, $dedupKey);
    }

    private function recordFailure(int $extractionId, int $rowIndex, string $message): void
    {
        try {
            ($this->linkInserter)(
                $extractionId,
                $rowIndex,
                self::RESOURCE_PROCEDURE_RESULT,
                0,
                'failed',
                $message,
            );
        } catch (\RuntimeException | \InvalidArgumentException | \LogicException) {
            // The link write itself failed; nothing more we can do
            // without unwinding earlier successes for other rows.
            // Swallow so the outer loop can continue to the next row.
        }
    }

    /**
     * Narrow a parsed JSON array to the string-keyed shape the row writer
     * expects. Non-string keys are dropped silently; integer-indexed
     * arrays would not match LabResultSchema anyway and will be caught
     * by the test_name absence check downstream.
     *
     * @param array<mixed, mixed> $row
     *
     * @return array<string, mixed>
     */
    private static function stringKeyed(array $row): array
    {
        $out = [];
        foreach ($row as $k => $v) {
            if (is_string($k)) {
                $out[$k] = $v;
            }
        }
        return $out;
    }

    private static function stringOrNull(mixed $v): ?string
    {
        if ($v === null) {
            return null;
        }
        if (is_string($v)) {
            return $v;
        }
        if (is_int($v) || is_float($v)) {
            return (string) $v;
        }
        return null;
    }

    /**
     * Build the procedure_result.result string. Prefer numeric_value
     * (typed at extraction) for chart trend math, fall back to
     * display_value.
     *
     * @param array<string, mixed> $row
     */
    private static function resolveValue(array $row): string
    {
        $num = $row['numeric_value'] ?? null;
        if (is_int($num) || is_float($num)) {
            return (string) $num;
        }
        $display = self::stringOrNull($row['display_value'] ?? null);
        if ($display === null || $display === '') {
            throw new \InvalidArgumentException('display_value missing');
        }
        return $display;
    }

    private static function resolveRange(mixed $range): string
    {
        if (!is_array($range)) {
            return '';
        }
        $raw = self::stringOrNull($range['raw_text'] ?? null);
        if ($raw !== null && $raw !== '') {
            return $raw;
        }
        $low  = $range['low']  ?? null;
        $high = $range['high'] ?? null;
        $lowStr  = (is_int($low)  || is_float($low))  ? (string) $low  : '';
        $highStr = (is_int($high) || is_float($high)) ? (string) $high : '';
        if ($lowStr === '' && $highStr === '') {
            return '';
        }
        return trim($lowStr . '-' . $highStr, '-');
    }

    /**
     * Map LabResultSchema.abnormal_flag → procedure_result.abnormal.
     * The lab schema is FHIR-aligned (N/L/H/LL/HH/A), the
     * procedure_result column is the legacy yes/no enum.
     */
    private static function resolveAbnormal(mixed $flag): string
    {
        if (!is_string($flag)) {
            return 'no';
        }
        return self::ABNORMAL_FLAG_MAP[$flag] ?? 'no';
    }

    /**
     * 'N' if the row has a numeric_value, else 'S' for string. Mirrors
     * the SyntheaLoader convention.
     *
     * @param array<string, mixed> $row
     */
    private static function resolveDataType(array $row): string
    {
        $num = $row['numeric_value'] ?? null;
        return (is_int($num) || is_float($num)) ? 'N' : 'S';
    }

    /**
     * Convert an ISO-8601 string to MySQL DATETIME. Falls back to the
     * current time when the input is null or unparseable so the
     * downstream procedure_* rows always carry a non-null timestamp.
     */
    private static function formatDateTime(?string $iso): string
    {
        if ($iso === null || $iso === '') {
            return (new DateTimeImmutable('now'))->format('Y-m-d H:i:s');
        }
        try {
            return (new DateTimeImmutable($iso))->format('Y-m-d H:i:s');
        } catch (\RuntimeException | \InvalidArgumentException | \LogicException) {
            return (new DateTimeImmutable('now'))->format('Y-m-d H:i:s');
        }
    }

    /** Dedup-key helper: normalize a test name to a stable token form. */
    private static function normalizeTestName(string $testName): string
    {
        $lower = mb_strtolower($testName);
        $stripped = preg_replace('/[^a-z0-9]+/', ' ', $lower);
        if (!is_string($stripped)) {
            $stripped = $lower;
        }
        return trim(preg_replace('/\s+/', ' ', $stripped) ?? $lower);
    }

    /**
     * Pull the YYYY-MM-DD prefix off a MySQL DATETIME string. Keeps the
     * dedup key stable even when one extraction reports a same-day
     * collection at 08:00 and another reports it at 14:00.
     */
    private static function extractDateOnly(string $collectedAt): string
    {
        if (preg_match('/^(\d{4}-\d{2}-\d{2})/', $collectedAt, $m) === 1) {
            return $m[1];
        }
        try {
            return (new DateTimeImmutable($collectedAt))->format('Y-m-d');
        } catch (\RuntimeException | \InvalidArgumentException | \LogicException) {
            return (new DateTimeImmutable('now'))->format('Y-m-d');
        }
    }
}
