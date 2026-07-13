<?php

/**
 * JobStatusController — GET upload-job status by UUID.
 *
 * The Document Inbox tab polls this endpoint every 1.5 seconds while a
 * job is in `pending` or `extracting`; polling stops on terminal states
 * or on `ready_for_review` (which hands off to the review screen).
 *
 * Response shape (JSON; PHI-free except for the explicit
 * `extracted_json` body returned only on `ready_for_review`):
 *   - job_uuid     : the requested UUID
 *   - status       : enum value ('pending'|'extracting'|'ready_for_review'
 *                    |'committed'|'rejected'|'failed')
 *   - doc_type     : 'lab_pdf' | 'intake_form'
 *   - document_id  : canonical Documents-tab id, used by the inbox to
 *                    build "View source" links
 *   - error_code   : nullable string, set on `failed`
 *   - error_message: nullable string, set on `failed` or partial commit
 *   - created_at   : ISO-ish DATETIME the row was inserted
 *   - updated_at   : ISO-ish DATETIME the row was last written
 *   - extracted_json: present only on `ready_for_review`; the editable
 *                     payload the review screen renders
 *
 * Patient binding: the HTTP entry point (interface/agentforge/jobs/
 * status.php) supplies the session-bound pid; the controller refuses
 * to serve a job whose patient_id does not match. This is in addition
 * to the `patients/docs` ACL gate so a user with chart access cannot
 * exfiltrate jobs across patients by guessing UUIDs.
 *
 * The HTTP entry point sets `Cache-Control: private, no-store`.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\AgentForge\Controller;

use OpenEMR\AgentForge\Domain\UploadJobStatus;
use OpenEMR\AgentForge\Persistence\SidecarPersister;
use OpenEMR\AgentForge\Persistence\UploadJobsPersister;

final readonly class JobStatusController
{
    public function __construct(
        private UploadJobsPersister $jobs,
        private SidecarPersister $sidecar,
    ) {
    }

    /**
     * Resolve the job-status response body for `$jobUuid` in the
     * context of `$sessionPid` (the patient bound to the active HTTP
     * session). Returns a typed result — the HTTP entry point is
     * responsible for translating it to a status code and JSON body.
     */
    public function handle(string $jobUuid, int $sessionPid): JobStatusResult
    {
        if ($jobUuid === '' || $sessionPid <= 0) {
            return JobStatusResult::notFound();
        }

        $view = $this->jobs->loadStatusView($jobUuid);
        if ($view === null) {
            return JobStatusResult::notFound();
        }

        if ($view->patientId !== $sessionPid) {
            // 403: a job exists but it does not belong to the active
            // patient context. We deliberately do NOT mask this as a
            // 404 — auditors need to see the cross-patient attempt in
            // the access log, and the inbox UI never legitimately
            // requests another patient's job uuid.
            return JobStatusResult::forbidden();
        }

        $extractedJson = null;
        if ($view->status === UploadJobStatus::ReadyForReview) {
            $row = $this->sidecar->loadByDocumentId($view->documentId);
            if ($row !== null) {
                $extractedJson = $row->originalJson;
            }
        }

        return JobStatusResult::ok($view, $extractedJson);
    }
}
