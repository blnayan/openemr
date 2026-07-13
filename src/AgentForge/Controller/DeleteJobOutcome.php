<?php

/**
 * DeleteJobOutcome — closed set of branches the POST delete endpoint
 * needs to render.
 *
 * Any status is deletable. For `committed` jobs the FHIR / `lists`
 * write-throughs are NOT unwound — the user is responsible for cleaning
 * those up via the canonical OpenEMR surfaces (Issues, Lab results,
 * etc.) before deleting the inbox row. For in-flight (`pending`,
 * `extracting`) jobs the dispatcher may still be writing; deletion is
 * still allowed but the user is taking on the race.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\AgentForge\Controller;

enum DeleteJobOutcome
{
    case Ok;
    case NotFound;
    case Forbidden;
}
