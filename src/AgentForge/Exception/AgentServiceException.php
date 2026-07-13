<?php

/**
 * AgentServiceException — raised when the upstream Node agent sidecar
 * returns a non-SSE response, times out, or refuses the JWT.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\AgentForge\Exception;

use RuntimeException;

final class AgentServiceException extends RuntimeException
{
}
