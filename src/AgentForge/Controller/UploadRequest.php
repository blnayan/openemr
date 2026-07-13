<?php

/**
 * UploadRequest — parsed boundary input for {@see UploadController::handle}.
 *
 * The Document Inbox rework replaces the legacy Documents-tab listener
 * path with an explicit upload endpoint. The HTTP entry point parses
 * the multipart form into this DTO before the controller runs, so the
 * controller's invariants (positive pid, supported MIME, in-bounds size,
 * valid doc_type) are encoded in the type system rather than re-checked
 * inline. Parse-don't-validate.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\AgentForge\Controller;

final readonly class UploadRequest
{
    public function __construct(
        public int $patientId,
        public string $patientUuid,
        public string $docType,
        public string $filename,
        public string $mimeType,
        public string $bytes,
        public string $authUser,
        public string $authProvider,
        public string $authRole,
        public string $sessionId,
        /**
         * Client-supplied job UUID. Lets the browser start polling
         * status.php with a known id BEFORE the upload XHR completes
         * (the XHR blocks for the synchronous extraction). Empty string
         * = server generates one (legacy behavior).
         */
        public string $jobUuid = '',
    ) {
    }
}
