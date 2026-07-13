<?php

/**
 * AclDeniedException — raised when the OpenEMR session does not satisfy
 * the patients/read ACL gate at the AgentForge controller boundary.
 * Caller translates to HTTP 403.
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

final class AclDeniedException extends DomainException
{
}
