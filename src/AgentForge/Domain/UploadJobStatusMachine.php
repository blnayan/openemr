<?php

/**
 * UploadJobStatusMachine — pure-function state machine for the Document
 * Inbox upload-job lifecycle.
 *
 * Given a current UploadJobStatus and an UploadJobTransition, returns
 * the new status or throws InvalidUploadJobTransitionException.
 * Terminal statuses (Committed, Rejected, Failed) reject every
 * transition.
 *
 * The class is stateless and side-effect-free; it is composed by
 * persistence callers (UploadJobsPersister, ConfirmCommitter) to
 * compute the next status before writing.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\AgentForge\Domain;

use OpenEMR\AgentForge\Exception\InvalidUploadJobTransitionException;

final class UploadJobStatusMachine
{
    /**
     * Compute the next status for the given (current, transition) pair.
     *
     * Implementation note: an outer match on the current status is
     * required because `match` without a default branch enables
     * PHPStan's exhaustiveness check; nesting an inner match per status
     * keeps every branch enum-on-enum and lets PHPStan verify that
     * every legal transition is handled. Illegal transitions throw
     * rather than fall through.
     *
     * @throws InvalidUploadJobTransitionException when the transition
     *         is not legal from $currentStatus, including any
     *         transition out of a terminal status.
     */
    public function next(
        UploadJobStatus $currentStatus,
        UploadJobTransition $transition,
    ): UploadJobStatus {
        return match ($currentStatus) {
            UploadJobStatus::Pending => $this->fromPending($transition),
            UploadJobStatus::Extracting => $this->fromExtracting($transition),
            UploadJobStatus::ReadyForReview => $this->fromReadyForReview($transition),
            UploadJobStatus::Committed,
            UploadJobStatus::Rejected,
            UploadJobStatus::Failed => throw new InvalidUploadJobTransitionException(
                $currentStatus,
                $transition,
            ),
        };
    }

    private function fromPending(UploadJobTransition $transition): UploadJobStatus
    {
        return match ($transition) {
            UploadJobTransition::StartExtraction => UploadJobStatus::Extracting,
            UploadJobTransition::Fail => UploadJobStatus::Failed,
            UploadJobTransition::ExtractionSucceeded,
            UploadJobTransition::Confirm,
            UploadJobTransition::Reject => throw new InvalidUploadJobTransitionException(
                UploadJobStatus::Pending,
                $transition,
            ),
        };
    }

    private function fromExtracting(UploadJobTransition $transition): UploadJobStatus
    {
        return match ($transition) {
            UploadJobTransition::ExtractionSucceeded => UploadJobStatus::ReadyForReview,
            UploadJobTransition::Fail => UploadJobStatus::Failed,
            UploadJobTransition::StartExtraction,
            UploadJobTransition::Confirm,
            UploadJobTransition::Reject => throw new InvalidUploadJobTransitionException(
                UploadJobStatus::Extracting,
                $transition,
            ),
        };
    }

    private function fromReadyForReview(UploadJobTransition $transition): UploadJobStatus
    {
        return match ($transition) {
            UploadJobTransition::Confirm => UploadJobStatus::Committed,
            UploadJobTransition::Reject => UploadJobStatus::Rejected,
            UploadJobTransition::StartExtraction,
            UploadJobTransition::ExtractionSucceeded,
            UploadJobTransition::Fail => throw new InvalidUploadJobTransitionException(
                UploadJobStatus::ReadyForReview,
                $transition,
            ),
        };
    }
}
