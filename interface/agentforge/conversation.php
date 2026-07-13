<?php

/**
 * AgentForge conversation history endpoint —
 * GET /interface/agentforge/conversation.php?id=<uuid>
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
use OpenEMR\AgentForge\Controller\ConversationController;
use OpenEMR\AgentForge\Exception\AclDeniedException;
use OpenEMR\AgentForge\Security\ScopedJwtMinter;
use OpenEMR\Common\Acl\AclMain;
use OpenEMR\Common\Session\SessionWrapperFactory;
use OpenEMR\Common\Uuid\UuidRegistry;
use OpenEMR\Services\PatientService;

header('X-Content-Type-Options: nosniff');

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    http_response_code(405);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'method_not_allowed']);
    exit;
}

if (!AclMain::aclCheckCore('patients', 'demo')) {
    http_response_code(403);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'forbidden']);
    exit;
}

$activeSession = SessionWrapperFactory::getInstance()->getActiveSession();
$authUser     = (string)($activeSession->get('authUser') ?? '');
$authProvider = (string)($activeSession->get('authProvider') ?? '');
$authRole     = (string)($activeSession->get('authUserID') ?? '');
$pid          = (int)($activeSession->get('pid') ?? 0);
$sessionId    = (string)$activeSession->getId();

if ($authUser === '' || $pid <= 0) {
    http_response_code(401);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'unauthorized']);
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

$conversationId = (string)($_GET['id'] ?? '');
$serviceUrl     = (string)($_ENV['AGENTFORGE_SERVICE_URL'] ?? getenv('AGENTFORGE_SERVICE_URL'));
$secret         = (string)($_ENV['AGENTFORGE_JWT_SECRET'] ?? getenv('AGENTFORGE_JWT_SECRET'));

if ($serviceUrl === '' || $secret === '') {
    http_response_code(503);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'agentforge_not_configured']);
    exit;
}

$psrRequest = (new ServerRequest('GET', '/interface/agentforge/conversation.php'))
    ->withAttribute('auth_user', $authUser)
    ->withAttribute('auth_provider', $authProvider)
    ->withAttribute('auth_role', $authRole)
    ->withAttribute('pid', $pid)
    ->withAttribute('patient_uuid', $patientUuid)
    ->withAttribute('session_id', $sessionId);

$controller = new ConversationController(
    $serviceUrl,
    new ScopedJwtMinter($secret, SystemClock::fromUTC()),
);

try {
    $response = $controller->handle($psrRequest, $conversationId);
    http_response_code($response['status']);
    foreach ($response['headers'] as $name => $value) {
        header("$name: $value");
    }
    echo $response['body'];
} catch (AclDeniedException) {
    http_response_code(403);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'forbidden']);
}
