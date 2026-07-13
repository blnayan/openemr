<?php

/**
 * RejectJobOutcome — closed set of branches the POST reject endpoint
 * needs to render.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\AgentForge\Controller;

enum RejectJobOutcome
{
    case Ok;
    case NotFound;
    case Forbidden;
}
