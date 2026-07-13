<?php

/**
 * IntakeWriteAdapter — translates an IntakeFormSchema payload into the
 * standard OpenEMR `lists` (type='medication', type='allergy') and
 * `pnotes` rows so intake forms round-trip into the same chart surfaces
 * Week 1 tools (`getMedications`, `getAllergies`) already read.
 *
 * For each entry in the extracted JSON:
 *
 *   - `current_medications[]` → `lists` row with `type='medication'`,
 *     populating name (title), dose, frequency, route, and an OTC flag
 *     in `comments` so the field survives without a schema change to
 *     `lists_medication`.
 *   - `allergies[]` → `lists` row with `type='allergy'`, populating
 *     substance (title), reaction, and severity (`severity_al`).
 *   - `chief_concern.text` (when non-null) → a single `pnotes` row
 *     tagged with title `AgentForge Intake Chief Concern` so the inbox
 *     and audit surfaces can filter intake-derived notes.
 *
 * Idempotency contract (added 2026-05-10):
 *
 *   - Medications are deduped on `(patient_id, lower(trim(name)))`. A
 *     second commit of the same drug UPDATEs dose/frequency/route on
 *     the existing `lists` row and counts as `updated` rather than
 *     inserting a duplicate. Different doses of the same drug still
 *     dedup to the same row — clinicians treat that as "Lisinopril
 *     dose changed", not "two separate scripts". The full history
 *     lives in `agentforge_chart_evidence`.
 *
 *   - Allergies are deduped on `(patient_id, lower(trim(substance)))`.
 *     Re-confirming the same allergy refreshes reaction/severity. (The
 *     writer-side closure may reconcile severity max-wins; the adapter
 *     just calls UPDATE with the new values.)
 *
 *   - Chief concern is INTENTIONALLY append-only. Each commit captures
 *     a moment in time, and a clinician needs to see "patient said X
 *     last week, Y today" without losing either. Every confirm writes
 *     a fresh pnotes row.
 *
 * Each successful write records a back-pointer in
 * `agentforge_resource_links` with resource_type one of
 * `medication`, `allergy`, or `pnote`, plus an evidence row in
 * `agentforge_chart_evidence` keyed on the natural dedup key.
 *
 * Demographics merge and family-history round-trip are explicitly NOT
 * written here (W2_DOCUMENT_INBOX_PRD §"Out of Scope").
 *
 * Per-bucket failure handling: a single bad row in any bucket does NOT
 * abort the rest of the document or the other buckets. The returned
 * {@see IntakeWriteOutcome} reports per-bucket successes, failures,
 * and the inserted/updated split so ConfirmCommitter can mark the
 * upload-job `committed` with a partial-success error_message and the
 * inbox can render the receipt UI.
 *
 * Collaborators are injected as closures so the adapter is unit-testable
 * without booting OpenEMR or hitting MySQL — mirrors the
 * {@see LabFhirAdapter} test posture.
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

final readonly class IntakeWriteAdapter
{
    public const RESOURCE_MEDICATION = 'medication';
    public const RESOURCE_ALLERGY    = 'allergy';
    public const RESOURCE_PNOTE      = 'pnote';

    /**
     * @param Closure(int $patientId, string $title, string $comments): int $medicationInserter
     *        Inserts a `lists` row with `type='medication'` and returns the new lists.id.
     * @param Closure(int $patientId, string $title, string $reaction, ?string $severity): int $allergyInserter
     *        Inserts a `lists` row with `type='allergy'` and returns the new lists.id.
     * @param Closure(int $patientId, string $title, string $body): int $pnoteInserter
     *        Inserts a `pnotes` row and returns the new pnotes.id.
     * @param Closure(int $extractionId, int $rowIndex, string $resourceType, int $resourceId, string $status, ?string $errorMessage): void $linkInserter
     *        Persists a back-pointer row in agentforge_resource_links.
     * @param ?Closure(int $patientId, string $dedupKey): ?int $existingMedicationFinder
     *        Returns the lists.id of an existing medication row matching
     *        the dedup key, or null. Defaulted to "always null" for legacy
     *        callers — the adapter falls back to insert-only.
     * @param ?Closure(int $listsId, string $title, string $comments): void $medicationUpdater
     *        Refreshes title/comments on an existing medication row.
     * @param ?Closure(int $patientId, string $dedupKey): ?int $existingAllergyFinder
     *        Returns the lists.id of an existing allergy row, or null.
     * @param ?Closure(int $listsId, string $title, string $reaction, ?string $severity): void $allergyUpdater
     *        Refreshes title/reaction/severity on an existing allergy row.
     * @param ?Closure(int $extractionId, int $patientId, string $chartTable, int $chartRowId, string $dedupKey): void $evidenceRecorder
     *        Appends a row to agentforge_chart_evidence.
     */
    public function __construct(
        private Closure $medicationInserter,
        private Closure $allergyInserter,
        private Closure $pnoteInserter,
        private Closure $linkInserter,
        private ?Closure $existingMedicationFinder = null,
        private ?Closure $medicationUpdater = null,
        private ?Closure $existingAllergyFinder = null,
        private ?Closure $allergyUpdater = null,
        private ?Closure $evidenceRecorder = null,
    ) {
    }

    /**
     * Write each intake bucket in $extracted to its OpenEMR target and
     * record back-pointers + evidence per row.
     *
     * @param int                  $extractionId agentforge_document_extractions.id
     * @param int                  $patientId    OpenEMR patient pid
     * @param array<string, mixed> $extracted    decoded IntakeFormSchema payload
     */
    public function writeThrough(int $extractionId, int $patientId, array $extracted): IntakeWriteOutcome
    {
        $medOutcome = $this->writeMedications(
            $extractionId,
            $patientId,
            $this->arrayOrEmpty($extracted['current_medications'] ?? null),
        );
        $allergyOutcome = $this->writeAllergies(
            $extractionId,
            $patientId,
            $this->arrayOrEmpty($extracted['allergies'] ?? null),
        );
        $concernOutcome = $this->writeChiefConcern(
            $extractionId,
            $patientId,
            $extracted['chief_concern'] ?? null,
        );

        return new IntakeWriteOutcome(
            medicationSuccesses:   $medOutcome['inserted'] + $medOutcome['updated'],
            medicationFailures:    $medOutcome['failures'],
            medicationErrors:      $medOutcome['errors'],
            allergySuccesses:      $allergyOutcome['inserted'] + $allergyOutcome['updated'],
            allergyFailures:       $allergyOutcome['failures'],
            allergyErrors:         $allergyOutcome['errors'],
            chiefConcernSuccesses: $concernOutcome['successes'],
            chiefConcernFailures:  $concernOutcome['failures'],
            chiefConcernError:     $concernOutcome['error'],
            medicationInserted:    $medOutcome['inserted'],
            medicationUpdated:     $medOutcome['updated'],
            allergyInserted:       $allergyOutcome['inserted'],
            allergyUpdated:        $allergyOutcome['updated'],
        );
    }

    /**
     * Build the dedup key for a medication or allergy row.
     *
     * Format: `<patient_id>|<bucket>|<normalized_name>` — opaque to
     * callers; matches the column type in `agentforge_chart_evidence`.
     */
    public static function dedupKey(int $patientId, string $bucket, string $name): string
    {
        return sprintf('%d|%s|%s', $patientId, $bucket, self::normalizeName($name));
    }

    /**
     * @param list<mixed> $medications
     *
     * @return array{inserted: int, updated: int, failures: int, errors: array<int, string>}
     */
    private function writeMedications(int $extractionId, int $patientId, array $medications): array
    {
        $inserted = 0;
        $updated  = 0;
        $failures = 0;
        $errors   = [];

        foreach ($medications as $rowIndex => $row) {
            if (!is_array($row)) {
                $failures++;
                $errors[$rowIndex] = 'row_not_object';
                $this->recordFailure($extractionId, $rowIndex, self::RESOURCE_MEDICATION, 'row_not_object');
                continue;
            }
            $stringKeyed = self::stringKeyed($row);

            try {
                $title = self::stringOrNull($stringKeyed['name'] ?? null);
                if ($title === null || $title === '') {
                    throw new \InvalidArgumentException('medication name missing');
                }
                $comments = self::buildMedicationComments($stringKeyed);
                $dedupKey = self::dedupKey($patientId, self::RESOURCE_MEDICATION, $title);

                $existingId = $this->lookupExisting($this->existingMedicationFinder, $patientId, $dedupKey);
                if ($existingId !== null) {
                    $this->applyMedicationUpdate($existingId, $title, $comments);
                    $this->recordEvidence($extractionId, $patientId, 'lists', $existingId, $dedupKey);
                    ($this->linkInserter)(
                        $extractionId,
                        $rowIndex,
                        self::RESOURCE_MEDICATION,
                        $existingId,
                        'written',
                        null,
                    );
                    $updated++;
                } else {
                    $listsId = ($this->medicationInserter)($patientId, $title, $comments);
                    $this->recordEvidence($extractionId, $patientId, 'lists', $listsId, $dedupKey);
                    ($this->linkInserter)(
                        $extractionId,
                        $rowIndex,
                        self::RESOURCE_MEDICATION,
                        $listsId,
                        'written',
                        null,
                    );
                    $inserted++;
                }
            } catch (\RuntimeException | \InvalidArgumentException | \LogicException $e) {
                $failures++;
                $errors[$rowIndex] = $e->getMessage();
                $this->recordFailure($extractionId, $rowIndex, self::RESOURCE_MEDICATION, $e->getMessage());
            }
        }

        return ['inserted' => $inserted, 'updated' => $updated, 'failures' => $failures, 'errors' => $errors];
    }

    /**
     * @param list<mixed> $allergies
     *
     * @return array{inserted: int, updated: int, failures: int, errors: array<int, string>}
     */
    private function writeAllergies(int $extractionId, int $patientId, array $allergies): array
    {
        $inserted = 0;
        $updated  = 0;
        $failures = 0;
        $errors   = [];

        foreach ($allergies as $rowIndex => $row) {
            if (!is_array($row)) {
                $failures++;
                $errors[$rowIndex] = 'row_not_object';
                $this->recordFailure($extractionId, $rowIndex, self::RESOURCE_ALLERGY, 'row_not_object');
                continue;
            }
            $stringKeyed = self::stringKeyed($row);

            try {
                $title = self::stringOrNull($stringKeyed['substance'] ?? null);
                if ($title === null || $title === '') {
                    throw new \InvalidArgumentException('allergy substance missing');
                }
                $reaction = self::stringOrNull($stringKeyed['reaction'] ?? null) ?? '';
                $severity = self::stringOrNull($stringKeyed['severity'] ?? null);
                $dedupKey = self::dedupKey($patientId, self::RESOURCE_ALLERGY, $title);

                $existingId = $this->lookupExisting($this->existingAllergyFinder, $patientId, $dedupKey);
                if ($existingId !== null) {
                    $this->applyAllergyUpdate($existingId, $title, $reaction, $severity);
                    $this->recordEvidence($extractionId, $patientId, 'lists', $existingId, $dedupKey);
                    ($this->linkInserter)(
                        $extractionId,
                        $rowIndex,
                        self::RESOURCE_ALLERGY,
                        $existingId,
                        'written',
                        null,
                    );
                    $updated++;
                } else {
                    $listsId = ($this->allergyInserter)($patientId, $title, $reaction, $severity);
                    $this->recordEvidence($extractionId, $patientId, 'lists', $listsId, $dedupKey);
                    ($this->linkInserter)(
                        $extractionId,
                        $rowIndex,
                        self::RESOURCE_ALLERGY,
                        $listsId,
                        'written',
                        null,
                    );
                    $inserted++;
                }
            } catch (\RuntimeException | \InvalidArgumentException | \LogicException $e) {
                $failures++;
                $errors[$rowIndex] = $e->getMessage();
                $this->recordFailure($extractionId, $rowIndex, self::RESOURCE_ALLERGY, $e->getMessage());
            }
        }

        return ['inserted' => $inserted, 'updated' => $updated, 'failures' => $failures, 'errors' => $errors];
    }

    /**
     * The chief concern is a single optional `pnotes` insert. It is
     * INTENTIONALLY append-only — each commit is a moment in time, never
     * deduped. Returns a 0/1 success, 0/1 failure tuple plus the error
     * string when the write threw.
     *
     * @return array{successes: int, failures: int, error: ?string}
     */
    private function writeChiefConcern(int $extractionId, int $patientId, mixed $concern): array
    {
        if ($concern === null) {
            return ['successes' => 0, 'failures' => 0, 'error' => null];
        }
        if (!is_array($concern)) {
            $this->recordFailure($extractionId, 0, self::RESOURCE_PNOTE, 'concern_not_object');
            return ['successes' => 0, 'failures' => 1, 'error' => 'concern_not_object'];
        }
        $stringKeyed = self::stringKeyed($concern);
        $text = self::stringOrNull($stringKeyed['text'] ?? null);
        if ($text === null || $text === '') {
            return ['successes' => 0, 'failures' => 0, 'error' => null];
        }

        try {
            $pnoteId = ($this->pnoteInserter)(
                $patientId,
                'AgentForge Intake Chief Concern',
                $text,
            );
            // Evidence still recorded so an auditor can see which
            // extraction asserted the note even though we don't dedup.
            $dedupKey = sprintf('%d|chief_concern|%d', $patientId, $extractionId);
            $this->recordEvidence($extractionId, $patientId, 'pnotes', $pnoteId, $dedupKey);
            ($this->linkInserter)(
                $extractionId,
                0,
                self::RESOURCE_PNOTE,
                $pnoteId,
                'written',
                null,
            );
            return ['successes' => 1, 'failures' => 0, 'error' => null];
        } catch (\RuntimeException | \InvalidArgumentException | \LogicException $e) {
            $this->recordFailure($extractionId, 0, self::RESOURCE_PNOTE, $e->getMessage());
            return ['successes' => 0, 'failures' => 1, 'error' => $e->getMessage()];
        }
    }

    private function lookupExisting(?Closure $finder, int $patientId, string $dedupKey): ?int
    {
        if ($finder === null) {
            return null;
        }
        $result = $finder($patientId, $dedupKey);
        return is_int($result) && $result > 0 ? $result : null;
    }

    private function applyMedicationUpdate(int $listsId, string $title, string $comments): void
    {
        if ($this->medicationUpdater === null) {
            return;
        }
        ($this->medicationUpdater)($listsId, $title, $comments);
    }

    private function applyAllergyUpdate(int $listsId, string $title, string $reaction, ?string $severity): void
    {
        if ($this->allergyUpdater === null) {
            return;
        }
        ($this->allergyUpdater)($listsId, $title, $reaction, $severity);
    }

    private function recordEvidence(int $extractionId, int $patientId, string $chartTable, int $chartRowId, string $dedupKey): void
    {
        if ($this->evidenceRecorder === null) {
            return;
        }
        ($this->evidenceRecorder)($extractionId, $patientId, $chartTable, $chartRowId, $dedupKey);
    }

    private function recordFailure(int $extractionId, int $rowIndex, string $resourceType, string $message): void
    {
        try {
            ($this->linkInserter)(
                $extractionId,
                $rowIndex,
                $resourceType,
                0,
                'failed',
                $message,
            );
        } catch (\RuntimeException | \InvalidArgumentException | \LogicException) {
            // Link insert itself failed; nothing more we can do
            // without unwinding successes for other rows. Swallow so
            // the outer loop can continue.
        }
    }

    /**
     * Compose the freeform `comments` blob for a medication row. Captures
     * the dose / frequency / route / OTC flag without touching
     * `lists_medication` (whose schema layers more fields than we have
     * extraction signal for). The comments string is stable and
     * machine-readable enough that downstream surfaces can re-parse it
     * if needed.
     *
     * @param array<string, mixed> $row
     */
    private static function buildMedicationComments(array $row): string
    {
        $parts = [];
        $dose = self::stringOrNull($row['dose'] ?? null);
        if ($dose !== null && $dose !== '') {
            $parts[] = 'dose: ' . $dose;
        }
        $frequency = self::stringOrNull($row['frequency'] ?? null);
        if ($frequency !== null && $frequency !== '') {
            $parts[] = 'frequency: ' . $frequency;
        }
        $route = self::stringOrNull($row['route'] ?? null);
        if ($route !== null && $route !== '') {
            $parts[] = 'route: ' . $route;
        }
        $otc = $row['is_otc_or_supplement'] ?? null;
        if (is_bool($otc) && $otc === true) {
            $parts[] = 'otc_or_supplement: yes';
        }
        return implode('; ', $parts);
    }

    /**
     * Narrow a parsed JSON array to the string-keyed shape the bucket
     * writers expect. Mirrors LabFhirAdapter::stringKeyed.
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

    /**
     * Coerce an extracted bucket to a list-shaped array. Anything else
     * (null, a scalar, an object instead of an array) collapses to an
     * empty list — the bucket simply produces no writes.
     *
     * @return list<mixed>
     */
    private function arrayOrEmpty(mixed $value): array
    {
        if (!is_array($value)) {
            return [];
        }
        return array_values($value);
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

    /** Dedup-key helper: lowercased, ASCII-collapsed, single-spaced. */
    private static function normalizeName(string $name): string
    {
        $lower = mb_strtolower($name);
        $stripped = preg_replace('/[^a-z0-9]+/', ' ', $lower);
        if (!is_string($stripped)) {
            $stripped = $lower;
        }
        return trim(preg_replace('/\s+/', ' ', $stripped) ?? $lower);
    }
}
