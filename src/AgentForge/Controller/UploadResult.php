<?php

/**
 * UploadResult — successful return from {@see UploadController::handle}.
 *
 * The controller persists source bytes, creates an upload-job row, and
 * dispatches extraction synchronously (mirroring the legacy listener's
 * timing semantics). The HTTP entry point serializes this DTO as the
 * `200 OK` response body so the Document Inbox stepper can begin
 * polling on `jobUuid`.
 *
 * `extractionDispatched` is `false` only when the agent service is
 * configured but its synchronous call returned an error and parked the
 * upload-job in `failed` — the inbox UI uses the field to render the
 * stepper's terminal state immediately rather than waiting on the
 * status poll.
 *
 * `duplicateOfJobUuid` carries the soft duplicate-warning advisory
 * (added 2026-05-10): when this upload's SHA-256 matches a prior
 * committed upload for the same patient, the prior job_uuid lands
 * here. The inbox UI renders a banner — "You committed this same PDF
 * on 2026-05-07; re-committing will not duplicate chart rows, but the
 * audit trail will record this as additional evidence" — without
 * blocking the upload. NULL on the happy path.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\AgentForge\Controller;

final readonly class UploadResult
{
    public function __construct(
        public string $jobUuid,
        public int $documentId,
        public int $patientId,
        public string $docType,
        public bool $extractionDispatched,
        public ?string $duplicateOfJobUuid = null,
        public ?string $duplicateOfFilename = null,
        public ?string $duplicateCommittedAt = null,
    ) {
    }
}
