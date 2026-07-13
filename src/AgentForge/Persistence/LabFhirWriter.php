<?php

/**
 * LabFhirWriter — production wiring of the LabFhirAdapter.
 *
 * Owns the concrete database inserters (procedure_order /
 * procedure_order_code / procedure_report / procedure_result and the
 * agentforge_resource_links back-pointer table) so the upload entry
 * point can hand off the extracted JSON in one call. All DB access goes
 * through {@see QueryUtils}, the procedure-provider lookup is memoized
 * per request, and UUIDs are minted via {@see UuidRegistry} to mirror
 * the SyntheaLoader path that produces the same FHIR Observations the
 * chart already trends.
 *
 * Also wires the chart-evidence audit trail (idempotency support added
 * 2026-05-10): a per-row evidence row in `agentforge_chart_evidence` is
 * appended on every write — both inserts and updates — keyed on the
 * dedup tuple `(patient_id, normalized_test_key, collection_date)`.
 * The lookup closure consults that table to decide whether the next
 * extraction should INSERT a fresh row or UPDATE the existing one.
 *
 * The class is otherwise a thin lambda-factory: every closure it
 * instantiates is a one-liner around {@see QueryUtils::sqlInsert} or
 * {@see QueryUtils::querySingleRow}. The translation logic itself
 * lives in {@see LabFhirAdapter}, which is unit-tested without a
 * database.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\AgentForge\Persistence;

use OpenEMR\Common\Database\QueryUtils;
use OpenEMR\Common\Uuid\UuidRegistry;

class LabFhirWriter implements DocumentWriter
{
    public const PROCEDURE_PROVIDER_NAME = 'AgentForge Demo Lab';
    public const CHART_TABLE_PROCEDURE_RESULT = 'procedure_result';

    /** Default OpenEMR provider id used by the SyntheaLoader fallback. */
    private const DEFAULT_PROVIDER_ID = 1;

    /**
     * Persist every LabResult row in the extracted payload to the
     * procedure_* chain and record back-pointer rows in
     * agentforge_resource_links. `documentId` is stamped on every
     * `procedure_result.document_id` so chat-time tools can attribute
     * each result back to its source PDF.
     *
     * @param array<string, mixed> $extracted
     */
    public function writeThrough(int $extractionId, int $patientId, int $documentId, array $extracted): LabWriteOutcome
    {
        return $this->buildAdapter($documentId)->writeThrough($extractionId, $patientId, $extracted);
    }

    private function buildAdapter(int $documentId): LabFhirAdapter
    {
        return new LabFhirAdapter(
            orderInserter:             self::orderInserter(),
            reportInserter:            self::reportInserter(),
            resultInserter:            self::resultInserter($documentId),
            linkInserter:              self::linkInserter(),
            procedureProviderResolver: self::procedureProviderResolver(),
            existingResultFinder:      self::existingResultFinder(),
            resultUpdater:             self::resultUpdater($documentId),
            evidenceRecorder:          self::evidenceRecorder($documentId),
        );
    }

    private static function orderInserter(): \Closure
    {
        return static function (
            int $patientId,
            string $loinc,
            string $testName,
            string $collectedAt,
            int $labProviderId,
        ): int {
            $orderUuid = (new UuidRegistry(['table_name' => 'procedure_order']))->createUuid();
            $orderId = (int) QueryUtils::sqlInsert(
                "INSERT INTO procedure_order "
                . "(uuid, provider_id, patient_id, encounter_id, date_collected, "
                . " date_ordered, order_status, activity, lab_id, procedure_order_type) "
                . "VALUES (?, ?, ?, 0, ?, ?, 'complete', 1, ?, 'laboratory_test')",
                [$orderUuid, self::DEFAULT_PROVIDER_ID, $patientId, $collectedAt, $collectedAt, $labProviderId],
            );
            QueryUtils::sqlInsert(
                "INSERT INTO procedure_order_code "
                . "(procedure_order_id, procedure_order_seq, procedure_code, procedure_name) "
                . "VALUES (?, 1, ?, ?)",
                [$orderId, $loinc, substr($testName, 0, 255)],
            );
            return $orderId;
        };
    }

    private static function reportInserter(): \Closure
    {
        return static function (int $orderId, string $reportedAt): int {
            $reportUuid = (new UuidRegistry(['table_name' => 'procedure_report']))->createUuid();
            return (int) QueryUtils::sqlInsert(
                "INSERT INTO procedure_report "
                . "(uuid, procedure_order_id, procedure_order_seq, date_collected, "
                . " date_report, source, report_status, review_status) "
                . "VALUES (?, ?, 1, ?, ?, ?, 'complete', 'reviewed')",
                [$reportUuid, $orderId, $reportedAt, $reportedAt, self::DEFAULT_PROVIDER_ID],
            );
        };
    }

    private static function resultInserter(int $documentId): \Closure
    {
        // documentId is captured by the closure so the row inserts always
        // stamp the source PDF; chat tools later read this column to
        // attribute "Cholesterol 232 (from p01-chen-lipid-panel.pdf)".
        // Falls back to 0 when the caller didn't supply one (tests, or
        // legacy code paths) — the column's default — so the row stays
        // valid and chat tools downgrade attribution to "(chart entry)".
        return static function (
            int $reportId,
            string $loinc,
            string $testName,
            string $resultedAt,
            string $units,
            string $value,
            string $range,
            string $abnormal,
            string $dataType,
        ) use ($documentId): int {
            $resultUuid = (new UuidRegistry(['table_name' => 'procedure_result']))->createUuid();
            return (int) QueryUtils::sqlInsert(
                "INSERT INTO procedure_result "
                . "(uuid, procedure_report_id, result_data_type, result_code, result_text, "
                . " date, units, result, `range`, abnormal, document_id, result_status) "
                . "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'final')",
                [
                    $resultUuid,
                    $reportId,
                    $dataType,
                    $loinc,
                    substr($testName, 0, 255),
                    $resultedAt,
                    substr($units, 0, 31),
                    substr($value, 0, 255),
                    $range,
                    $abnormal,
                    $documentId,
                ],
            );
        };
    }

    private static function linkInserter(): \Closure
    {
        // The agentforge_resource_links table created by
        // contrib/agentforge/run_migrations.php (migration 20260505120004)
        // has columns: id, extraction_id, resource_type, resource_id,
        // created_at. The adapter passes row_index/status/error_message
        // for future use, but they have nowhere to land yet — only persist
        // 'written' rows; failures are surfaced via LabWriteOutcome.
        return static function (
            int $extractionId,
            int $rowIndex,
            string $resourceType,
            int $resourceId,
            string $status,
            ?string $errorMessage,
        ): void {
            // unused-binding silencers (see comment above)
            unset($rowIndex, $errorMessage);
            if ($status !== 'written') {
                return;
            }
            QueryUtils::sqlInsert(
                "INSERT INTO agentforge_resource_links "
                . "(extraction_id, resource_type, resource_id, created_at) "
                . "VALUES (?, ?, ?, NOW())",
                [$extractionId, $resourceType, (string) $resourceId],
            );
        };
    }

    /**
     * Look up an existing procedure_result.id for a (patient, dedupKey)
     * pair. Returns null when no prior commit asserted the same lab row,
     * in which case the adapter falls through to the standard insert
     * chain. Reads from `agentforge_chart_evidence` (added in the
     * 20260510120000 migration), keyed on the table's
     * (patient_id, chart_table, dedup_key) index.
     *
     * Multiple evidence rows can carry the same dedup key (one per
     * extraction that asserted it). They all point at the same chart
     * row — pick the most recent for stability.
     */
    private static function existingResultFinder(): \Closure
    {
        return static function (int $patientId, string $dedupKey): ?int {
            $row = QueryUtils::querySingleRow(
                "SELECT chart_row_id "
                . "FROM agentforge_chart_evidence "
                . "WHERE patient_id = ? AND chart_table = ? AND dedup_key = ? "
                . "ORDER BY id DESC LIMIT 1",
                [$patientId, self::CHART_TABLE_PROCEDURE_RESULT, $dedupKey],
            );
            if (!is_array($row)) {
                return null;
            }
            $id = $row['chart_row_id'] ?? null;
            if (is_int($id)) {
                return $id > 0 ? $id : null;
            }
            if (is_string($id) && ctype_digit($id)) {
                $idInt = (int) $id;
                return $idInt > 0 ? $idInt : null;
            }
            return null;
        };
    }

    /**
     * UPDATE an existing procedure_result row when the dedup key matches.
     * Refreshes value/units/range/abnormal/data_type/date and re-stamps
     * `document_id` so the latest source PDF wins (the evidence trail
     * still preserves the prior document ids).
     */
    private static function resultUpdater(int $documentId): \Closure
    {
        return static function (
            int $resultId,
            string $units,
            string $value,
            string $range,
            string $abnormal,
            string $dataType,
            string $resultedAt,
        ) use ($documentId): void {
            QueryUtils::sqlStatementThrowException(
                "UPDATE procedure_result SET "
                . "result_data_type = ?, units = ?, result = ?, `range` = ?, "
                . "abnormal = ?, date = ?, document_id = ? "
                . "WHERE procedure_result_id = ?",
                [
                    $dataType,
                    substr($units, 0, 31),
                    substr($value, 0, 255),
                    $range,
                    $abnormal,
                    $resultedAt,
                    $documentId,
                    $resultId,
                ],
            );
        };
    }

    /**
     * Append an evidence row tying the dedup key to the chart row.
     * Always writes — both INSERT and UPDATE paths land here so the
     * chart row carries the full history of every extraction that
     * asserted it.
     */
    private static function evidenceRecorder(int $documentId): \Closure
    {
        $sourceDocId = $documentId > 0 ? $documentId : null;
        return static function (int $extractionId, int $patientId, int $resultId, string $dedupKey) use ($sourceDocId): void {
            QueryUtils::sqlInsert(
                "INSERT INTO agentforge_chart_evidence "
                . "(patient_id, chart_table, chart_row_id, dedup_key, extraction_id, document_id, committed_at) "
                . "VALUES (?, ?, ?, ?, ?, ?, NOW())",
                [
                    $patientId,
                    self::CHART_TABLE_PROCEDURE_RESULT,
                    $resultId,
                    $dedupKey,
                    $extractionId,
                    $sourceDocId,
                ],
            );
        };
    }

    private static function procedureProviderResolver(): \Closure
    {
        return static function (): int {
            $name = self::PROCEDURE_PROVIDER_NAME;
            $existing = self::lookupProcedureProviderId($name);
            if ($existing > 0) {
                return $existing;
            }
            QueryUtils::sqlInsert(
                "INSERT INTO procedure_providers (name, npi, send_app_id, recv_app_id) "
                . "VALUES (?, '', '', '')",
                [$name],
            );
            return self::lookupProcedureProviderId($name);
        };
    }

    /**
     * @return int 0 when the row is missing or carries a non-numeric ppid.
     */
    private static function lookupProcedureProviderId(string $name): int
    {
        $row = QueryUtils::querySingleRow(
            "SELECT ppid FROM procedure_providers WHERE name = ?",
            [$name],
        );
        if (!is_array($row)) {
            return 0;
        }
        $ppid = $row['ppid'] ?? null;
        if (is_int($ppid)) {
            return $ppid;
        }
        if (is_string($ppid) && ctype_digit($ppid)) {
            return (int) $ppid;
        }
        return 0;
    }
}
