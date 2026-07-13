<?php

/**
 * InvalidUploadJobTransitionException — thrown by
 * UploadJobStatusMachine::next() when the requested transition is not
 * legal from the supplied current status (including any transition
 * from a terminal status).
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
use OpenEMR\AgentForge\Domain\UploadJobTransition;

final class InvalidUploadJobTransitionException extends DomainException
{
    public function __construct(
        public readonly UploadJobStatus $currentStatus,
        public readonly UploadJobTransition $transition,
    ) {
        parent::__construct(sprintf(
            'Illegal upload-job transition: %s from status %s',
            $transition->name,
            $currentStatus->value,
        ));
    }
}
