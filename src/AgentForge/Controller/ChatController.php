<?php

/**
 * ChatController — entry point for POST /interface/agentforge/chat.
 * Verifies the OpenEMR session through PSR-7 request attributes,
 * mints a 120-second JWT, and proxies the SSE response from the Node
 * agent sidecar.
 *
 * Auth precondition: the entry-point file populates the request with
 * 'auth_user', 'auth_provider', 'auth_role', 'pid', 'patient_uuid', and
 * 'session_id' attributes after running AclMain::aclCheckCore at the
 * boundary. Missing attributes throw AclDeniedException so the caller
 * can render HTTP 403.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\AgentForge\Controller;

use OpenEMR\AgentForge\Audit\AgentAuditService;
use OpenEMR\AgentForge\DTO\ChatRequest;
use OpenEMR\AgentForge\Exception\AclDeniedException;
use OpenEMR\AgentForge\Http\SseProxyHandler;
use OpenEMR\AgentForge\Security\ScopedJwtClaims;
use OpenEMR\AgentForge\Security\ScopedJwtMinter;
use Psr\Http\Message\ServerRequestInterface;

final class ChatController
{
    public function __construct(
        private readonly ScopedJwtMinter $jwtMinter,
        private readonly SseProxyHandler $sseProxy,
        private readonly AgentAuditService $audit,
    ) {
    }

    /**
     * @throws AclDeniedException when the request is not authenticated
     * @throws \InvalidArgumentException on malformed body
     */
    public function handle(ServerRequestInterface $request): void
    {
        $authUser = $request->getAttribute('auth_user');
        $authProvider = $request->getAttribute('auth_provider');
        $authRole = $request->getAttribute('auth_role');
        $pid = $request->getAttribute('pid');
        $patientUuid = $request->getAttribute('patient_uuid');
        $sessionId = $request->getAttribute('session_id');

        if (
            !is_string($authUser) || $authUser === ''
            || !is_int($pid) || $pid <= 0
            || !is_string($patientUuid) || $patientUuid === ''
        ) {
            throw new AclDeniedException('AgentForge chat requires an authenticated session');
        }

        $body = $request->getParsedBody();
        if (!is_array($body)) {
            throw new \InvalidArgumentException('Request body must be a parsed array');
        }

        $chatRequest = new ChatRequest(
            question: $this->stringField($body, 'question'),
            conversationId: $this->nullableStringField($body, 'conversation_id'),
            encounterId: $this->nullablePositiveIntField($body, 'encounter_id'),
            mode: $this->nullableModeField($body, 'mode'),
        );

        $this->validateQuestion($chatRequest->question);

        $auditUser     = $authUser;
        $auditProvider = is_string($authProvider) ? $authProvider : '';
        $auditRole     = is_string($authRole) ? $authRole : '';

        $this->audit->logEvent(
            AgentAuditService::EVENT_CHAT_START,
            $auditUser,
            $auditProvider,
            true,
            $this->renderComments($chatRequest),
            $pid,
        );

        $claims = new ScopedJwtClaims(
            userId: $auditUser,
            groupname: $auditProvider,
            role: $auditRole,
            pid: $pid,
            patientUuid: $patientUuid,
            encounterId: $chatRequest->encounterId,
            sessionId: is_string($sessionId) ? $sessionId : '',
            scope: ScopedJwtMinter::SCOPE,
        );

        $jwt = $this->jwtMinter->mint($claims);

        $this->sseProxy->proxy($jwt, $chatRequest);
    }

    private function validateQuestion(string $question): void
    {
        if ($question === '') {
            throw new \InvalidArgumentException('question must not be empty');
        }
        if (strlen($question) > ChatRequest::MAX_QUESTION_LENGTH) {
            throw new \InvalidArgumentException(
                'question exceeds maximum of ' . ChatRequest::MAX_QUESTION_LENGTH . ' characters'
            );
        }
    }

    /** @param array<string, mixed> $body */
    private function stringField(array $body, string $key): string
    {
        $value = $body[$key] ?? null;
        if (!is_string($value)) {
            throw new \InvalidArgumentException("Missing or invalid field: $key");
        }
        return $value;
    }

    /** @param array<string, mixed> $body */
    private function nullableStringField(array $body, string $key): ?string
    {
        if (!array_key_exists($key, $body) || $body[$key] === null) {
            return null;
        }
        if (!is_string($body[$key])) {
            throw new \InvalidArgumentException("Field $key must be a string or null");
        }
        return $body[$key];
    }

    /** @param array<string, mixed> $body */
    private function nullablePositiveIntField(array $body, string $key): ?int
    {
        if (!array_key_exists($key, $body) || $body[$key] === null) {
            return null;
        }
        $value = $body[$key];
        if (!is_int($value) || $value <= 0) {
            throw new \InvalidArgumentException("Field $key must be a positive integer or null");
        }
        return $value;
    }

    /** @param array<string, mixed> $body */
    private function nullableModeField(array $body, string $key): ?string
    {
        if (!array_key_exists($key, $body) || $body[$key] === null) {
            return null;
        }
        $value = $body[$key];
        if (!is_string($value) || !in_array($value, [ChatRequest::MODE_PREVISIT, ChatRequest::MODE_FOLLOWUP], true)) {
            throw new \InvalidArgumentException("Field $key must be \"previsit\" or \"followup\"");
        }
        return $value;
    }

    private function renderComments(ChatRequest $request): string
    {
        return json_encode([
            'conversation_id' => $request->conversationId,
            'question_length' => strlen($request->question),
            'encounter_id'    => $request->encounterId,
        ], JSON_THROW_ON_ERROR);
    }
}
