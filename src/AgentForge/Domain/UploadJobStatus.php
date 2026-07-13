<?php

/**
 * UploadJobStatus — closed enum encoding the six-state Document Inbox
 * upload-job state machine.
 *
 * The Document Inbox rework (W2_DOCUMENT_INBOX_PRD.md) replaces the
 * Documents-tab listener path with an explicit upload controller and a
 * deferred-commit review flow. Every upload-job row in
 * `agentforge_upload_jobs.status` is one of these six values, and every
 * persistence write goes through this enum so PHPStan level 10 catches
 * stringly-typed transitions at static-analysis time.
 *
 * Terminal cases: Committed, Rejected, Failed. None of these accept
 * further transitions; see UploadJobStatusMachine for the transition
 * rules.
 *
 * The backing string values are the on-disk representation persisted to
 * the `agentforge_upload_jobs.status` VARCHAR column — they must remain
 * stable across releases.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\AgentForge\Domain;

enum UploadJobStatus: string
{
    case Pending = 'pending';
    case Extracting = 'extracting';
    case ReadyForReview = 'ready_for_review';
    case Committed = 'committed';
    case Rejected = 'rejected';
    case Failed = 'failed';

    /**
     * Returns true when the status is terminal — no further transitions
     * are legal from a terminal status, regardless of which transition
     * is requested.
     */
    public function isTerminal(): bool
    {
        return match ($this) {
            self::Committed, self::Rejected, self::Failed => true,
            self::Pending, self::Extracting, self::ReadyForReview => false,
        };
    }
}
