<?php

/**
 * ConfirmJobOutcome — closed set of branches the POST confirm endpoint
 * needs to render.
 *
 * The 409 conflict on stale status is signaled by the
 * {@see \OpenEMR\AgentForge\Exception\UploadJobNotReadyForReviewException}
 * the committer throws — it is not enumerated here so the HTTP layer
 * can pull the `current_status` out of the exception.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\AgentForge\Controller;

enum ConfirmJobOutcome
{
    case Ok;
    case NotFound;
    case Forbidden;
}
