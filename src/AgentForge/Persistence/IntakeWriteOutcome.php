<?php

/**
 * IntakeWriteOutcome — aggregate result of IntakeWriteAdapter::writeThrough.
 *
 * Mirrors {@see LabWriteOutcome}'s shape so ConfirmCommitter can route
 * partial-success messaging uniformly across doc types. Tracks per-bucket
 * counts (medications, allergies, chief-concern pnote) so a clinician
 * looking at the upload-job's error_message can see which sub-writes
 * failed without re-reading the full extraction.
 *
 * Insert vs update split: medication and allergy writes are idempotent
 * on the natural dedup key (patient + lower(name)/lower(substance)) — a
 * second commit of the same row UPDATEs the existing chart row rather
 * than inserting a duplicate. Chief-concern is intentionally
 * append-only (each commit is a moment in time, never deduped). The
 * `inserted` and `updated` counters expose that split for the receipt UI.
 *
 * Buckets are intentional: the partial-success contract requires that a
 * failure in any one bucket does not block the others, so each bucket
 * carries its own success/failure count.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\AgentForge\Persistence;

final readonly class IntakeWriteOutcome implements WriteOutcome
{
    /**
     * @param array<int, string> $medicationErrors row_index → error message
     * @param array<int, string> $allergyErrors    row_index → error message
     */
    public function __construct(
        public int $medicationSuccesses,
        public int $medicationFailures,
        public array $medicationErrors,
        public int $allergySuccesses,
        public int $allergyFailures,
        public array $allergyErrors,
        public int $chiefConcernSuccesses,
        public int $chiefConcernFailures,
        public ?string $chiefConcernError,
        public int $medicationInserted = 0,
        public int $medicationUpdated = 0,
        public int $allergyInserted = 0,
        public int $allergyUpdated = 0,
    ) {
    }

    public function totalRows(): int
    {
        return $this->medicationSuccesses
            + $this->medicationFailures
            + $this->allergySuccesses
            + $this->allergyFailures
            + $this->chiefConcernSuccesses
            + $this->chiefConcernFailures;
    }

    public function totalSuccesses(): int
    {
        return $this->medicationSuccesses
            + $this->allergySuccesses
            + $this->chiefConcernSuccesses;
    }

    public function totalFailures(): int
    {
        return $this->medicationFailures
            + $this->allergyFailures
            + $this->chiefConcernFailures;
    }

    public function isClean(): bool
    {
        return $this->totalFailures() === 0;
    }

    public function isPartialFailure(): bool
    {
        return $this->totalFailures() > 0 && $this->totalSuccesses() > 0;
    }

    public function isTotalFailure(): bool
    {
        return $this->totalFailures() > 0 && $this->totalSuccesses() === 0;
    }

    public function insertedCount(): int
    {
        // Chief concern is append-only: every success counts as an
        // insert in the receipt math.
        return $this->medicationInserted
            + $this->allergyInserted
            + $this->chiefConcernSuccesses;
    }

    public function updatedCount(): int
    {
        return $this->medicationUpdated + $this->allergyUpdated;
    }

    /**
     * Human-readable summary suitable for the upload-job's error_message
     * column when the outcome is a partial failure. Stable shape so
     * downstream UI / inbox queries can rely on the prefix to detect
     * the partial-success case.
     */
    public function partialFailureSummary(): string
    {
        $parts = [];
        if ($this->medicationFailures > 0) {
            $parts[] = sprintf('%d medication(s) failed', $this->medicationFailures);
        }
        if ($this->allergyFailures > 0) {
            $parts[] = sprintf('%d allergy(ies) failed', $this->allergyFailures);
        }
        if ($this->chiefConcernFailures > 0) {
            $parts[] = 'chief concern failed';
        }
        if ($parts === []) {
            return '';
        }
        return 'partial: ' . implode('; ', $parts);
    }

    /**
     * Short human-readable receipt of what landed on the chart, broken
     * out per bucket. Empty buckets are omitted so a med-only intake
     * doesn't say "0 allergies".
     */
    public function receipt(): string
    {
        $segments = [];
        $segments[] = self::bucketReceipt('medications', $this->medicationInserted, $this->medicationUpdated, $this->medicationFailures);
        $segments[] = self::bucketReceipt('allergies', $this->allergyInserted, $this->allergyUpdated, $this->allergyFailures);
        if ($this->chiefConcernSuccesses > 0 || $this->chiefConcernFailures > 0) {
            $cc = [];
            if ($this->chiefConcernSuccesses > 0) {
                $cc[] = sprintf('%d added', $this->chiefConcernSuccesses);
            }
            if ($this->chiefConcernFailures > 0) {
                $cc[] = sprintf('%d failed', $this->chiefConcernFailures);
            }
            $segments[] = sprintf('%s (chief concern)', implode(', ', $cc));
        }
        $nonEmpty = array_values(array_filter($segments, static fn(string $s): bool => $s !== ''));
        if ($nonEmpty === []) {
            return 'No intake rows to write.';
        }
        return implode('; ', $nonEmpty);
    }

    private static function bucketReceipt(string $label, int $inserted, int $updated, int $failures): string
    {
        if ($inserted === 0 && $updated === 0 && $failures === 0) {
            return '';
        }
        $parts = [];
        if ($inserted > 0) {
            $parts[] = sprintf('%d added', $inserted);
        }
        if ($updated > 0) {
            $parts[] = sprintf('%d updated', $updated);
        }
        if ($failures > 0) {
            $parts[] = sprintf('%d failed', $failures);
        }
        return sprintf('%s (%s)', implode(', ', $parts), $label);
    }
}
