<?php

/**
 * ExtractionClient — server-to-server HTTP client that POSTs an
 * uploaded document's bytes to the Node agent sidecar's /extract
 * endpoint and returns the parsed response.
 *
 * Invoked from DocumentExtractionSubscriber after the document has
 * been persisted via DocumentService. The Node sidecar runs the VLM
 * extraction pipeline and returns either the structured JSON or a
 * structured error; this client maps the HTTP status code to a
 * typed PHP result.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\AgentForge\Http;

use OpenEMR\AgentForge\Exception\AgentServiceException;

class ExtractionClient
{
    public function __construct(
        private readonly string $agentServiceBaseUrl,
        private readonly int $timeoutSeconds = 90,
    ) {
    }

    /**
     * Synchronously call /extract. Returns a structured result that
     * the caller switches on by `kind`.
     *
     * @throws AgentServiceException on transport failure (the agent
     *         service is unreachable or returned a non-JSON body).
     */
    public function extract(ExtractionRequest $request): ExtractionResponse
    {
        $payload = json_encode([
            'document_id'  => $request->documentId,
            'patient_id'   => $request->patientId,
            'doc_type'     => $request->docType,
            'mime_type'    => $request->mimeType,
            'bytes_base64' => base64_encode($request->bytes),
        ], JSON_THROW_ON_ERROR);

        $url = rtrim($this->agentServiceBaseUrl, '/') . '/extract';

        $ch = curl_init($url);
        if ($ch === false) {
            throw new AgentServiceException('Failed to initialize curl handle');
        }
        curl_setopt_array($ch, [
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => $payload,
            CURLOPT_HTTPHEADER     => [
                'Authorization: Bearer ' . $request->jwt,
                'Content-Type: application/json',
                'Accept: application/json',
            ],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => $this->timeoutSeconds,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_FOLLOWLOCATION => false,
        ]);

        $body = curl_exec($ch);
        $err  = curl_error($ch);
        $errno = curl_errno($ch);
        $statusCode = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);

        if ($body === false) {
            throw new AgentServiceException('Agent /extract request failed: ' . $err);
        }
        if (!is_string($body)) {
            throw new AgentServiceException('Agent /extract returned non-string body');
        }

        $decoded = json_decode($body, true);
        if (!is_array($decoded)) {
            throw new AgentServiceException(
                'Agent /extract returned non-JSON body (status ' . $statusCode . ')'
            );
        }

        if ($statusCode === 200) {
            $extracted     = $decoded['extracted'] ?? null;
            $schemaVersion = $decoded['schema_version'] ?? null;
            $pageCount     = $decoded['page_count'] ?? null;
            if (!is_array($extracted) || !is_string($schemaVersion) || !is_int($pageCount)) {
                throw new AgentServiceException(
                    'Agent /extract 200 response missing required fields'
                );
            }
            return ExtractionResponse::success(
                extracted:     $extracted,
                schemaVersion: $schemaVersion,
                pageCount:     $pageCount,
            );
        }

        $errorCode = is_string($decoded['error'] ?? null) ? $decoded['error'] : 'unknown_error';
        $errorMsg  = is_string($decoded['message'] ?? null) ? $decoded['message'] : '';
        $attempts  = is_int($decoded['attempts'] ?? null) ? $decoded['attempts'] : null;

        return ExtractionResponse::failure(
            statusCode: $statusCode,
            errorCode:  $errorCode,
            message:    $errorMsg,
            attempts:   $attempts,
        );
    }
}
