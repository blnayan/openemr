<?php

/**
 * AgentForge chat entry point — POST /interface/agentforge/chat.php
 *
 * Bootstraps OpenEMR globals, runs the patient ACL gate, parses the JSON
 * body into PSR-7 attributes, then hands off to ChatController which
 * mints the per-turn JWT and proxies the SSE response from the Node
 * agent sidecar.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

require_once __DIR__ . '/../globals.php';

use Lcobucci\Clock\SystemClock;
use Nyholm\Psr7\ServerRequest;
use OpenEMR\AgentForge\Audit\AgentAuditService;
use OpenEMR\AgentForge\Controller\ChatController;
use OpenEMR\AgentForge\Exception\AclDeniedException;
use OpenEMR\AgentForge\Exception\AgentServiceException;
use OpenEMR\AgentForge\Http\SseProxyHandler;
use OpenEMR\AgentForge\Security\ScopedJwtMinter;
use OpenEMR\Common\Acl\AclMain;
use OpenEMR\Common\Logging\EventAuditLogger;
use OpenEMR\Common\Session\SessionWrapperFactory;
use OpenEMR\Services\PatientService;
use OpenEMR\Common\Uuid\UuidRegistry;

set_time_limit(90);
ini_set('zlib.output_compression', '0');
while (ob_get_level() > 0) {
    @ob_end_flush();
}

header('X-Content-Type-Options: nosniff');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'method_not_allowed']);
    exit;
}

$activeSession = SessionWrapperFactory::getInstance()->getActiveSession();
$authUser = (string)($activeSession->get('authUser') ?? '');
$authProvider = (string)($activeSession->get('authProvider') ?? '');
$pid = (int)($activeSession->get('pid') ?? 0);
$sessionId = (string)$activeSession->getId();

if (!AclMain::aclCheckCore('patients', 'demo')) {
    http_response_code(403);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'forbidden']);
    EventAuditLogger::getInstance()->newEvent(
        AgentAuditService::EVENT_ACL_DENIED,
        $authUser !== '' ? $authUser : 'unknown',
        $authProvider,
        false,
        'AgentForge chat ACL denied',
        $pid,
        'open-emr',
    );
    exit;
}

if ($pid <= 0) {
    http_response_code(400);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'no_patient_in_session']);
    exit;
}

$patientService = new PatientService();
$rawUuid = $patientService->getUuid((string)$pid);
if ($rawUuid === false) {
    http_response_code(500);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'patient_uuid_unavailable']);
    exit;
}
$patientUuid = UuidRegistry::uuidToString($rawUuid);

$rawBody = file_get_contents('php://input');
$parsed  = is_string($rawBody) ? json_decode($rawBody, true) : null;
// Don't log the raw body — `question` carries free-text PHI ("Has Mrs Chen's
// HbA1c improved since…?"). Log shape only so we can still triage 400s.
error_log(sprintf(
    'AgentForge chat.php body: bytes=%d json_ok=%s',
    is_string($rawBody) ? strlen($rawBody) : 0,
    is_array($parsed) ? 'yes' : 'no',
));
if (!is_array($parsed)) {
    $parsed = [];
}

$psrRequest = (new ServerRequest('POST', '/interface/agentforge/chat.php'))
    ->withParsedBody($parsed)
    ->withAttribute('auth_user', $authUser)
    ->withAttribute('auth_provider', $authProvider)
    ->withAttribute('auth_role', (string)($activeSession->get('authUserID') ?? ''))
    ->withAttribute('pid', $pid)
    ->withAttribute('patient_uuid', $patientUuid)
    ->withAttribute('session_id', $sessionId);

$secret = (string)($_ENV['AGENTFORGE_JWT_SECRET'] ?? getenv('AGENTFORGE_JWT_SECRET'));
$serviceUrl = (string)($_ENV['AGENTFORGE_SERVICE_URL'] ?? getenv('AGENTFORGE_SERVICE_URL'));

if ($secret === '' || $serviceUrl === '') {
    http_response_code(503);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'agentforge_not_configured']);
    exit;
}

$controller = new ChatController(
    new ScopedJwtMinter($secret, SystemClock::fromUTC()),
    new SseProxyHandler($serviceUrl),
    new AgentAuditService(EventAuditLogger::getInstance()),
);

try {
    $controller->handle($psrRequest);
} catch (AclDeniedException) {
    http_response_code(403);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'forbidden']);
} catch (\InvalidArgumentException $e) {
    // No body in the log — it contains the user's clinical question (PHI).
    error_log('AgentForge chat.php InvalidArgumentException: ' . $e->getMessage());
    http_response_code(400);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'bad_request']);
} catch (AgentServiceException $e) {
    // Headers may already be sent (SSE). Best-effort error event was emitted.
    error_log('AgentForge chat.php AgentServiceException: ' . $e->getMessage());
} catch (\Throwable $e) {
    error_log('AgentForge chat.php unexpected: ' . $e->getMessage());
    if (!headers_sent()) {
        http_response_code(500);
        header('Content-Type: application/json');
        echo json_encode(['error' => 'internal']);
    }
}
