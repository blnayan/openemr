<?php

/**
 * UploadJobStatusView — read-only projection an
 * `agentforge_upload_jobs` row exposes to the Document Inbox poller.
 *
 * Returned by {@see UploadJobsPersister::loadStatusView()} and consumed
 * by {@see \OpenEMR\AgentForge\Controller\JobStatusController}. The
 * projection is narrowed to the fields the inbox UI's stepper needs —
 * status (the four-step `uploaded → extracting → review → committed`
 * stepper plus `rejected` / `failed` terminals), doc_type so the review
 * screen knows which schema to render, document_id so the canonical
 * Documents-tab "view source" link can be built, and the typed
 * error_code / error_message strings the inbox surfaces on failure.
 *
 * `patientId` is included so the controller can enforce the
 * pid-binding invariant — a session bound to patient A must not be
 * served the status of a job that belongs to patient B even when
 * `patients/docs` ACL permits seeing patient documents in general.
 *
 * No PHI lives in this projection: filenames, extracted text, and
 * bounding boxes never appear here. The sidecar JSON is fetched
 * separately and returned only on `ready_for_review`.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\AgentForge\Persistence;

use OpenEMR\AgentForge\Domain\UploadJobStatus;

final readonly class UploadJobStatusView
{
    public function __construct(
        public string $jobUuid,
        public int $documentId,
        public int $patientId,
        public string $docType,
        public UploadJobStatus $status,
        public ?string $errorCode,
        public ?string $errorMessage,
        public ?string $createdAt,
        public ?string $updatedAt,
    ) {
    }
}
