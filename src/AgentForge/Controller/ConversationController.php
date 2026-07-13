<?php

/**
 * ConversationController — GET /interface/agentforge/conversation/{id}.
 * Returns the persisted message history for one conversation as JSON,
 * authenticated by the same per-turn HS256 JWT used for chat.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\AgentForge\Controller;

use OpenEMR\AgentForge\Exception\AclDeniedException;
use OpenEMR\AgentForge\Security\ScopedJwtClaims;
use OpenEMR\AgentForge\Security\ScopedJwtMinter;
use Psr\Http\Message\ServerRequestInterface;

final class ConversationController
{
    public function __construct(
        private readonly string $agentServiceBaseUrl,
        private readonly ScopedJwtMinter $jwtMinter,
        private readonly int $timeoutSeconds = 10,
    ) {
    }

    /**
     * @return array{status:int, body:string, headers:array<string,string>}
     */
    public function handle(ServerRequestInterface $request, string $conversationId): array
    {
        if (!preg_match('/^[a-f0-9-]{36}$/i', $conversationId)) {
            return [
                'status'  => 400,
                'body'    => json_encode(['error' => 'invalid_conversation_id']) ?: '{}',
                'headers' => ['Content-Type' => 'application/json'],
            ];
        }

        $authUser     = $request->getAttribute('auth_user');
        $authProvider = $request->getAttribute('auth_provider');
        $authRole     = $request->getAttribute('auth_role');
        $pid          = $request->getAttribute('pid');
        $patientUuid  = $request->getAttribute('patient_uuid');
        $sessionId    = $request->getAttribute('session_id');

        if (
            !is_string($authUser) || $authUser === ''
            || !is_int($pid) || $pid <= 0
            || !is_string($patientUuid) || $patientUuid === ''
        ) {
            throw new AclDeniedException('Authentication required');
        }

        $jwt = $this->jwtMinter->mint(new ScopedJwtClaims(
            userId: $authUser,
            groupname: is_string($authProvider) ? $authProvider : '',
            role: is_string($authRole) ? $authRole : '',
            pid: $pid,
            patientUuid: $patientUuid,
            encounterId: null,
            sessionId: is_string($sessionId) ? $sessionId : '',
            scope: ScopedJwtMinter::SCOPE,
        ));

        $url = rtrim($this->agentServiceBaseUrl, '/') . '/conversation/' . urlencode($conversationId);

        $context = stream_context_create([
            'http' => [
                'method'        => 'GET',
                'timeout'       => $this->timeoutSeconds,
                'header'        => "Authorization: Bearer $jwt\r\n",
                'ignore_errors' => true,
            ],
        ]);

        $body = @file_get_contents($url, false, $context);
        if ($body === false) {
            return [
                'status'  => 502,
                'body'    => json_encode(['error' => 'agent_unavailable']) ?: '{}',
                'headers' => ['Content-Type' => 'application/json'],
            ];
        }

        // Surface the upstream status code so a 401 from a stale JWT or a
        // 404 from a missing conversation is visible to the caller.
        $status = 200;
        if (isset($http_response_header) && is_array($http_response_header) && $http_response_header !== []) {
            $statusLine = $http_response_header[0];
            if (preg_match('#HTTP/\S+\s+(\d{3})#', $statusLine, $m)) {
                $status = (int)$m[1];
            }
        }

        return [
            'status'  => $status,
            'body'    => $body,
            'headers' => ['Content-Type' => 'application/json'],
        ];
    }
}
