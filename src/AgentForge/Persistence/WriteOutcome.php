<?php

/**
 * WriteOutcome — common shape for the aggregate result of a doc-type
 * writer's write-through pass.
 *
 * The Document Inbox rework introduces a writer-by-doc-type map that
 * ConfirmCommitter consumes to route between LabFhirWriter (lab_pdf)
 * and IntakeWriter (intake_form, issue 23). Each writer's
 * writeThrough() reports its own per-row successes and failures, but
 * the orchestration layer (ConfirmCommitter and the upload-jobs status
 * machine) only needs a small subset of those facts: how many rows
 * wrote cleanly, how many failed, and whether the document had no rows
 * at all (an empty extraction is "clean" by convention).
 *
 * Mirrors LabWriteOutcome's existing shape so LabWriteOutcome can
 * implement this interface without behavioral change.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\AgentForge\Persistence;

interface WriteOutcome
{
    public function totalRows(): int;

    public function isClean(): bool;

    public function isPartialFailure(): bool;

    public function isTotalFailure(): bool;

    /**
     * Count of rows that were INSERTED (i.e. no prior chart row matched
     * the entity's dedup key). Always 0 when the writer does not
     * differentiate insert vs update; otherwise `inserted + updated == successes`.
     */
    public function insertedCount(): int;

    /**
     * Count of rows that were UPDATED — the writer found an existing
     * chart row keyed on the entity's natural dedup key and refreshed
     * it instead of inserting a duplicate. Drives the receipt UI's
     * "X added / Y updated" message.
     */
    public function updatedCount(): int;

    /**
     * Short human-readable summary, e.g.
     *   "3 added, 2 updated (lab results)"
     *   "1 added, 1 updated (medications); 1 added (allergies)"
     * Suitable for the upload-job's success message and the inbox UI's
     * post-commit banner.
     */
    public function receipt(): string;
}
