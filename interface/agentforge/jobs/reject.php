<?php

/**
 * AgentForge job-reject endpoint — POST /interface/agentforge/jobs/reject.php
 *
 * Whole-document reject path. Transitions the upload-job to `rejected`
 * and stamps the sidecar's reviewer-provenance columns. No FHIR /
 * `lists` writes occur on this path.
 *
 * Request body (JSON):
 *   { "job_uuid": "..." }
 *
 * Authorization:
 *   - `aclCheckCore('patients', 'docs', '', 'write')` — write
 *     sub-privilege; the same gate the canonical Documents tab guards.
 *   - The session must be bound to the patient that owns the job.
 *
 * Response shapes:
 *   200 OK             — { status: 'rejected' }
 *   404 Not Found      — { error: 'not_found' }
 *   403 Forbidden      — { error: 'forbidden' }
 *   409 Conflict       — { error: 'not_ready_for_review',
 *                           current_status: '<status>' }
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

require_once __DIR__ . '/../../globals.php';

use OpenEMR\AgentForge\Controller\RejectJobController;
use OpenEMR\AgentForge\Controller\RejectJobOutcome;
use OpenEMR\AgentForge\Domain\UploadJobStatusMachine;
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

$jobs    = new UploadJobsPersister();
$sidecar = new SidecarPersister();

$committer = new ConfirmCommitter(
    labWriter:        new LabFhirWriter(),
    writersByDocType: ['intake_form' => new IntakeWriter()],
    jobs:             $jobs,
    sidecar:          $sidecar,
    statusMachine:    new UploadJobStatusMachine(),
);

$controller = new RejectJobController($jobs, RejectJobController::defaultReject($committer));

try {
    $result = $controller->handle($jobUuid, $userId, $sessionPid);
} catch (UploadJobNotReadyForReviewException $e) {
    http_response_code(409);
    echo json_encode([
        'error'          => 'not_ready_for_review',
        'current_status' => $e->currentStatus->value,
    ]);
    return;
} catch (\RuntimeException | \LogicException | \JsonException | \InvalidArgumentException $e) {
    ServiceContainer::getLogger()->error('AgentForge jobs/reject.php failed', [
        'job_uuid'  => $jobUuid,
        'exception' => $e,
    ]);
    http_response_code(500);
    echo json_encode(['error' => 'internal']);
    return;
}

$status = match ($result->outcome) {
    RejectJobOutcome::NotFound  => 404,
    RejectJobOutcome::Forbidden => 403,
    RejectJobOutcome::Ok        => 200,
};
http_response_code($status);

if ($result->outcome === RejectJobOutcome::NotFound) {
    echo json_encode(['error' => 'not_found']);
    return;
}
if ($result->outcome === RejectJobOutcome::Forbidden) {
    echo json_encode(['error' => 'forbidden']);
    return;
}

echo json_encode(['status' => 'rejected']);
