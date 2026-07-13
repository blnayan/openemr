<?php

/**
 * AgentForge job-status endpoint — GET /interface/agentforge/jobs/status.php
 *
 * The Document Inbox tab polls this endpoint every 1.5 seconds while a
 * job is in `pending` or `extracting`. Stops polling on terminal states
 * (`committed` / `rejected` / `failed`) or on `ready_for_review` (which
 * hands off to the review screen — the response body for that state
 * carries the editable extracted JSON inline).
 *
 * Query parameters:
 *   - job_uuid (required) — the upload-job UUID returned by upload.php.
 *
 * Authorization:
 *   - `aclCheckCore('patients', 'docs')` (read sub-privilege governs
 *     visibility of the inbox). Write is NOT required for status polls.
 *   - The session must be bound to the patient that owns the job; a
 *     pid mismatch returns 403 even when the ACL passes.
 *
 * Response shapes:
 *   200 OK             — { job_uuid, status, doc_type, document_id,
 *                          patient_id, error_code, error_message,
 *                          created_at, updated_at, [extracted_json] }
 *   404 Not Found      — { error: 'not_found' }
 *   403 Forbidden      — { error: 'forbidden' }
 *
 * Sets `Cache-Control: private, no-store` so polling responses do not
 * persist in shared caches.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

require_once __DIR__ . '/../../globals.php';

use OpenEMR\AgentForge\Controller\JobStatusController;
use OpenEMR\AgentForge\Controller\JobStatusOutcome;
use OpenEMR\AgentForge\Persistence\SidecarPersister;
use OpenEMR\AgentForge\Persistence\UploadJobsPersister;
use OpenEMR\BC\ServiceContainer;
use OpenEMR\Common\Acl\AclMain;
use OpenEMR\Common\Session\SessionWrapperFactory;

header('X-Content-Type-Options: nosniff');
header('Content-Type: application/json');
header('Cache-Control: private, no-store');

// @phpstan-ignore openemr.forbiddenRequestGlobals
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
    http_response_code(405);
    header('Allow: GET');
    echo json_encode(['error' => 'method_not_allowed']);
    return;
}

if (!AclMain::aclCheckCore('patients', 'docs')) {
    http_response_code(403);
    echo json_encode(['error' => 'forbidden']);
    return;
}

$activeSession = SessionWrapperFactory::getInstance()->getActiveSession();
$sessionPidRaw = $activeSession->get('pid');
$sessionPid = is_int($sessionPidRaw) ? $sessionPidRaw
    : (is_string($sessionPidRaw) && ctype_digit($sessionPidRaw) ? (int) $sessionPidRaw : 0);
if ($sessionPid <= 0) {
    http_response_code(400);
    echo json_encode(['error' => 'no_patient_in_session']);
    return;
}

// @phpstan-ignore openemr.forbiddenRequestGlobals
$jobUuidRaw = $_GET['job_uuid'] ?? '';
$jobUuid = is_string($jobUuidRaw) ? $jobUuidRaw : '';
if ($jobUuid === '' || preg_match('/^[A-Za-z0-9_-]{1,64}$/', $jobUuid) !== 1) {
    http_response_code(400);
    echo json_encode(['error' => 'invalid_job_uuid']);
    return;
}

$controller = new JobStatusController(
    new UploadJobsPersister(),
    new SidecarPersister(),
);

try {
    $result = $controller->handle($jobUuid, $sessionPid);
} catch (\RuntimeException | \LogicException | \JsonException $e) {
    ServiceContainer::getLogger()->error('AgentForge jobs/status.php failed', [
        'job_uuid'  => $jobUuid,
        'exception' => $e,
    ]);
    http_response_code(500);
    echo json_encode(['error' => 'internal']);
    return;
}

$status = match ($result->outcome) {
    JobStatusOutcome::NotFound  => 404,
    JobStatusOutcome::Forbidden => 403,
    JobStatusOutcome::Ok        => 200,
};
http_response_code($status);

if ($result->outcome === JobStatusOutcome::NotFound) {
    echo json_encode(['error' => 'not_found']);
    return;
}
if ($result->outcome === JobStatusOutcome::Forbidden) {
    echo json_encode(['error' => 'forbidden']);
    return;
}

$view = $result->view;
if ($view === null) {
    // Defensive — JobStatusResult::ok() always sets the view, but
    // PHPStan needs a narrowing here.
    http_response_code(500);
    echo json_encode(['error' => 'internal']);
    return;
}

$body = [
    'job_uuid'      => $view->jobUuid,
    'status'        => $view->status->value,
    'doc_type'      => $view->docType,
    'document_id'   => $view->documentId,
    'patient_id'    => $view->patientId,
    'error_code'    => $view->errorCode,
    'error_message' => $view->errorMessage,
    'created_at'    => $view->createdAt,
    'updated_at'    => $view->updatedAt,
];
if ($result->extractedJson !== null) {
    $body['extracted_json'] = $result->extractedJson;
}
echo json_encode($body);
