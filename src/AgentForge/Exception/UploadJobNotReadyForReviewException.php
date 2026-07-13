<?php

/**
 * UploadJobNotReadyForReviewException — thrown by ConfirmCommitter when
 * a confirm or whole-document reject arrives for an upload-job that is
 * not in the `ready_for_review` status.
 *
 * The HTTP layer (issue 26) maps this to HTTP 409 Conflict so a
 * double-confirm or a stale browser tab does not cause a duplicate
 * FHIR write or a write-against-rejected-document race.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\AgentForge\Exception;

use DomainException;
use OpenEMR\AgentForge\Domain\UploadJobStatus;

final class UploadJobNotReadyForReviewException extends DomainException
{
    public function __construct(
        public readonly string $jobUuid,
        public readonly UploadJobStatus $currentStatus,
    ) {
        parent::__construct(sprintf(
            'Upload job %s is not ready for review (current status: %s)',
            $jobUuid,
            $currentStatus->value,
        ));
    }
}
