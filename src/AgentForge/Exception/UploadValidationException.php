<?php

/**
 * UploadValidationException — boundary rejection from
 * {@see UploadController}.
 *
 * Carries a stable, code-style error string the HTTP entry point maps
 * to a 4xx response with a clear message for the Document Inbox UI.
 * Distinct typed reasons keep the controller's `match` exhaustive at
 * static-analysis time.
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
use OpenEMR\AgentForge\Controller\UploadValidationReason;

final class UploadValidationException extends DomainException
{
    public function __construct(
        public readonly UploadValidationReason $reason,
        string $message,
    ) {
        parent::__construct($message);
    }
}
