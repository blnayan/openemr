<?php

/**
 * AgentForge inbox-row delete endpoint —
 * POST /interface/agentforge/jobs/delete.php
 *
 * Removes an upload-job's inbox surface (upload-job row + sidecar +
 * resource-links) AND the underlying OpenEMR `documents` row + the
 * file on disk so the deleted document also disappears from the
 * canonical Documents tab. FHIR / `lists` write-throughs from a
 * previously-committed job are NOT unwound here — the user is
 * responsible for cleaning those up via the OpenEMR surfaces that
 * own them.
 *
 * Request body (JSON):
 *   { "job_uuid": "..." }
 *
 * Authorization:
 *   - `aclCheckCore('patients', 'docs', '', 'write')` — the same
 *     write-grade gate the reject and confirm endpoints use.
 *   - The session must be bound to the patient that owns the job.
 *
 * Response shapes:
 *   200 OK             — { status: 'deleted' }
 *   404 Not Found      — { error: 'not_found' }
 *   403 Forbidden      — { error: 'forbidden' }
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

require_once __DIR__ . '/../../globals.php';

use OpenEMR\AgentForge\Controller\DeleteJobController;
use OpenEMR\AgentForge\Controller\DeleteJobOutcome;
use OpenEMR\AgentForge\Persistence\InboxRowDeleter;
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
$deleter = new InboxRowDeleter();

$controller = new DeleteJobController(
    $jobs,
    DeleteJobController::defaultDelete($deleter),
);

try {
    $result = $controller->handle($jobUuid, $sessionPid);
} catch (\RuntimeException | \LogicException | \JsonException | \InvalidArgumentException $e) {
    ServiceContainer::getLogger()->error('AgentForge jobs/delete.php failed', [
        'job_uuid'  => $jobUuid,
        'exception' => $e,
    ]);
    http_response_code(500);
    echo json_encode(['error' => 'internal']);
    return;
}

$status = match ($result->outcome) {
    DeleteJobOutcome::NotFound  => 404,
    DeleteJobOutcome::Forbidden => 403,
    DeleteJobOutcome::Ok        => 200,
};
http_response_code($status);

if ($result->outcome === DeleteJobOutcome::NotFound) {
    echo json_encode(['error' => 'not_found']);
    return;
}
if ($result->outcome === DeleteJobOutcome::Forbidden) {
    echo json_encode(['error' => 'forbidden']);
    return;
}

echo json_encode(['status' => 'deleted']);
