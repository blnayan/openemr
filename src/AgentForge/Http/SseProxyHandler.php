<?php

/**
 * SseProxyHandler — opens a streaming HTTP request to the Node agent
 * sidecar and forwards SSE events back to the browser. The PHP worker
 * is held open for the duration of one chat turn (D7).
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\AgentForge\Http;

use OpenEMR\AgentForge\DTO\ChatRequest;
use OpenEMR\AgentForge\Exception\AgentServiceException;

class SseProxyHandler
{
    public function __construct(
        private readonly string $agentServiceBaseUrl,
        private readonly int $timeoutSeconds = 90,
    ) {
    }

    /**
     * Send the SSE response headers, then stream events from the agent
     * service to the browser until the upstream stream ends or the
     * timeout fires.
     */
    public function proxy(string $jwt, ChatRequest $request): void
    {
        $this->emitSseHeaders();

        $payload = json_encode([
            'question'        => $request->question,
            'conversation_id' => $request->conversationId,
            'encounter_id'    => $request->encounterId,
            'mode'            => $request->mode,
        ], JSON_THROW_ON_ERROR);

        $url = rtrim($this->agentServiceBaseUrl, '/') . '/chat';

        $ch = curl_init($url);
        if ($ch === false) {
            throw new AgentServiceException('Failed to initialize curl handle');
        }

        $writer = function ($_ch, string $chunk): int {
            echo $chunk;
            $this->flush();
            return strlen($chunk);
        };

        curl_setopt_array($ch, [
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => $payload,
            CURLOPT_HTTPHEADER     => [
                'Authorization: Bearer ' . $jwt,
                'Content-Type: application/json',
                'Accept: text/event-stream',
            ],
            CURLOPT_WRITEFUNCTION  => $writer,
            CURLOPT_TIMEOUT        => $this->timeoutSeconds,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_RETURNTRANSFER => false,
        ]);

        $ok = curl_exec($ch);
        $err = curl_error($ch);
        $errno = curl_errno($ch);
        $statusCode = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $effectiveUrl = (string) curl_getinfo($ch, CURLINFO_EFFECTIVE_URL);
        curl_close($ch);

        error_log(sprintf(
            'AgentForge SSE proxy: url=%s status=%d errno=%d err=%s',
            $effectiveUrl, $statusCode, $errno, $err,
        ));

        if ($ok === false) {
            $this->emitErrorEvent('agent_unavailable');
            throw new AgentServiceException('Agent service request failed: ' . $err);
        }

        if ($statusCode >= 400) {
            $this->emitErrorEvent('agent_status_' . $statusCode);
        }
    }

    private function emitSseHeaders(): void
    {
        if (headers_sent()) {
            return;
        }
        header('Content-Type: text/event-stream');
        header('Cache-Control: no-cache, no-transform');
        header('X-Accel-Buffering: no');
        header('Connection: keep-alive');
    }

    private function emitErrorEvent(string $reason): void
    {
        echo "event: error\n";
        echo 'data: ' . json_encode(['reason' => $reason]) . "\n\n";
        $this->flush();
    }

    private function flush(): void
    {
        if (function_exists('ob_get_level') && ob_get_level() > 0) {
            @ob_flush();
        }
        @flush();
    }
}
