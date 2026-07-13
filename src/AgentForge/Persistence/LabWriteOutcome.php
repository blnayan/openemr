<?php

/**
 * Aggregate outcome of LabFhirAdapter::writeThrough.
 *
 * Carries the success/failure counts for an extracted document plus a
 * per-row error map. The caller surfaces this on the upload-jobs row
 * so partial-failure documents are distinguishable from clean
 * write-throughs.
 *
 * Insert vs update split: the lab writer is idempotent on the natural
 * dedup key (patient, normalized test name | LOINC, collection date).
 * `inserted` is the count of rows the writer created fresh; `updated`
 * is the count it refreshed against an existing chart row. Their sum
 * is `successes` for backwards compatibility with callers that only
 * care about the clean/partial/total flags.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\AgentForge\Persistence;

final readonly class LabWriteOutcome implements WriteOutcome
{
    /**
     * @param array<int, string> $rowErrors row_index → error message for failed rows
     */
    public function __construct(
        public int $successes,
        public int $failures,
        public array $rowErrors,
        public int $inserted = 0,
        public int $updated = 0,
    ) {
    }

    public function totalRows(): int
    {
        return $this->successes + $this->failures;
    }

    public function isClean(): bool
    {
        return $this->failures === 0;
    }

    public function isPartialFailure(): bool
    {
        return $this->failures > 0 && $this->successes > 0;
    }

    public function isTotalFailure(): bool
    {
        return $this->failures > 0 && $this->successes === 0;
    }

    public function insertedCount(): int
    {
        return $this->inserted;
    }

    public function updatedCount(): int
    {
        return $this->updated;
    }

    public function receipt(): string
    {
        if ($this->successes === 0 && $this->failures === 0) {
            return 'No lab rows to write.';
        }
        $parts = [];
        if ($this->inserted > 0) {
            $parts[] = sprintf('%d added', $this->inserted);
        }
        if ($this->updated > 0) {
            $parts[] = sprintf('%d updated', $this->updated);
        }
        // Fall back to a single "successes" line for legacy callers that
        // construct LabWriteOutcome without the inserted/updated split.
        if ($parts === [] && $this->successes > 0) {
            $parts[] = sprintf('%d written', $this->successes);
        }
        if ($this->failures > 0) {
            $parts[] = sprintf('%d failed', $this->failures);
        }
        return implode(', ', $parts) . ' (lab results)';
    }
}
