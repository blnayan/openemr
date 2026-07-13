<?php

/**
 * JobStatusOutcome — closed set of branches the GET status endpoint
 * needs to render.
 *
 * Used by {@see JobStatusResult} so the HTTP entry point's `match` on
 * the outcome is exhaustive at PHPStan level 10.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\AgentForge\Controller;

enum JobStatusOutcome
{
    case Ok;
    case NotFound;
    case Forbidden;
}
