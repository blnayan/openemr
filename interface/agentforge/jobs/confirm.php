<?php

/**
 * AgentForge job-confirm endpoint — POST /interface/agentforge/jobs/confirm.php
 *
 * Accepts the reviewer's edited JSON, runs the doc-type writer, stamps
 * provenance, and transitions the upload-job to `committed`. The
 * strict-status invariant lives in {@see ConfirmCommitter} — a
 * double-confirm or stale-tab confirm receives 409 Conflict per the
 * Document Inbox PRD so neither {@see LabFhirWriter} nor
 * {@see IntakeWriter} need "what if I already wrote this?" branches.
 *
 * Request body (JSON):
 *   { "job_uuid": "...", "edited_json": { ... } }
 *
 * Authorization:
 *   - `aclCheckCore('patients', 'docs', '', 'write')` — write
 *     sub-privilege; the inbox UI gates the Confirm button identically.
 *   - The session must be bound to the patient that owns the job.
 *
 * Response shapes:
 *   200 OK   — { status: 'committed', total_rows, is_clean }
 *   404 Not Found       — { error: 'not_found' }
 *   403 Forbidden       — { error: 'forbidden' }
 *   409 Conflict        — { error: 'not_ready_for_review',
 *                            current_status: '<status>' }
 *   500 Internal Error  — { error: 'internal' }
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

require_once __DIR__ . '/../../globals.php';

use OpenEMR\AgentForge\Controller\ConfirmJobController;
use OpenEMR\AgentForge\Controller\ConfirmJobOutcome;
use OpenEMR\AgentForge\Domain\UploadJobStatusMachine;
use OpenEMR\AgentForge\Exception\UnknownDocTypeException;
use OpenEMR\AgentForge\Exception\UploadJobNotReadyForReviewException;
use OpenEMR\AgentForge\Persistence\ConfirmCommitter;
use OpenEMR\AgentForge\Persistence\IntakeWriter;
use OpenEMR\AgentForge\Persistence\LabFhirWriter;
use OpenEMR\AgentForge\Persistence\SidecarPersister;
use OpenEMR\AgentForge\Persistence\UploadJobsPersister;
use OpenEMR\BC\ServiceContainer;
use OpenEMR\Common\Acl\AclMain;
use OpenEMR\Common\Session\SessionWrapperFactory;

header('X-Content-Type-Options: nosniff');
header('Content-Type: application/json');
header('Cache-Control: private, no-store');

// @phpstan-ignore openemr.forbiddenRequestGlobals
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
    http_response_code(405);
    header('Allow: POST');
    echo json_encode(['error' => 'method_not_allowed']);
    return;
}

if (!AclMain::aclCheckCore('patients', 'docs', '', 'write')) {
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

$authUserIdRaw = $activeSession->get('authUserID');
$userId = is_int($authUserIdRaw) ? $authUserIdRaw
    : (is_string($authUserIdRaw) && ctype_digit($authUserIdRaw) ? (int) $authUserIdRaw : 0);
if ($userId <= 0) {
    http_response_code(401);
    echo json_encode(['error' => 'unauthenticated']);
    return;
}

$rawBody = file_get_contents('php://input');
$parsed  = is_string($rawBody) ? json_decode($rawBody, true) : null;
if (!is_array($parsed)) {
    http_response_code(400);
    echo json_encode(['error' => 'invalid_json_body']);
    return;
}

$jobUuidRaw = $parsed['job_uuid'] ?? '';
$jobUuid = is_string($jobUuidRaw) ? $jobUuidRaw : '';
if ($jobUuid === '' || preg_match('/^[A-Za-z0-9_-]{1,64}$/', $jobUuid) !== 1) {
    http_response_code(400);
    echo json_encode(['error' => 'invalid_job_uuid']);
    return;
}

$editedRaw = $parsed['edited_json'] ?? null;
if (!is_array($editedRaw)) {
    http_response_code(400);
    echo json_encode(['error' => 'invalid_edited_json']);
    return;
}
// Narrow to string-keyed shape — ConfirmCommitter expects an
// associative payload (matches the VLM extraction envelope).
$editedJson = [];
foreach ($editedRaw as $key => $value) {
    if (is_string($key)) {
        $editedJson[$key] = $value;
    }
}

$jobs    = new UploadJobsPersister();
$sidecar = new SidecarPersister();

$committer = new ConfirmCommitter(
    labWriter:        new LabFhirWriter(),
    writersByDocType: ['intake_form' => new IntakeWriter()],
    jobs:             $jobs,
    sidecar:          $sidecar,
    statusMachine:    new UploadJobStatusMachine(),
);

$controller = new ConfirmJobController($jobs, ConfirmJobController::defaultConfirm($committer));

try {
    $result = $controller->handle($jobUuid, $editedJson, $userId, $sessionPid);
} catch (UploadJobNotReadyForReviewException $e) {
    http_response_code(409);
    echo json_encode([
        'error'          => 'not_ready_for_review',
        'current_status' => $e->currentStatus->value,
    ]);
    return;
} catch (UnknownDocTypeException $e) {
    ServiceContainer::getLogger()->error('AgentForge jobs/confirm.php unknown doc_type', [
        'job_uuid'  => $jobUuid,
        'doc_type'  => $e->docType,
    ]);
    http_response_code(500);
    echo json_encode(['error' => 'internal']);
    return;
} catch (\RuntimeException | \LogicException | \JsonException | \InvalidArgumentException $e) {
    ServiceContainer::getLogger()->error('AgentForge jobs/confirm.php failed', [
        'job_uuid'  => $jobUuid,
        'exception' => $e,
    ]);
    http_response_code(500);
    echo json_encode(['error' => 'internal']);
    return;
}

if ($result->outcome === ConfirmJobOutcome::NotFound) {
    http_response_code(404);
    echo json_encode(['error' => 'not_found']);
    return;
}
if ($result->outcome === ConfirmJobOutcome::Forbidden) {
    http_response_code(403);
    echo json_encode(['error' => 'forbidden']);
    return;
}

$writeOutcome = $result->writeOutcome;
if ($writeOutcome === null) {
    http_response_code(500);
    echo json_encode(['error' => 'internal']);
    return;
}

http_response_code(200);
echo json_encode([
    'status'     => 'committed',
    'total_rows' => $writeOutcome->totalRows(),
    'is_clean'   => $writeOutcome->isClean(),
]);
