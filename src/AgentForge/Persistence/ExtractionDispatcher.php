<?php

/**
 * ExtractionDispatcher — extract-only orchestrator for the agent
 * `/extract` round-trip and the resulting sidecar persistence.
 *
 * The Document Inbox rework (W2_DOCUMENT_INBOX_PRD.md) splits the
 * legacy "extract + write-through" flow into two phases:
 *   1. This dispatcher performs extraction, persists the sidecar row,
 *      and transitions the upload-job to `ready_for_review`.
 *   2. {@see ConfirmCommitter} is the only path from a
 *      ready-for-review sidecar to a FHIR or `lists` write.
 *
 * Lab values therefore no longer round-trip into FHIR Observations the
 * moment extraction completes — a clinician must Confirm in the
 * inbox first. This makes the deferred-commit gate the structural
 * defense against VLM misreads.
 *
 * Caller contract: the upload-job row already exists in `pending`
 * (created by the upload controller / legacy listener). This class
 * transitions Pending → Extracting before the network call and either
 * Extracting → ReadyForReview (success) or Extracting → Failed
 * (error). Both transitions go through {@see UploadJobStatusMachine}.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\AgentForge\Persistence;

use OpenEMR\AgentForge\Domain\UploadJobStatus;
use OpenEMR\AgentForge\Domain\UploadJobStatusMachine;
use OpenEMR\AgentForge\Domain\UploadJobTransition;
use OpenEMR\AgentForge\Http\ExtractionClient;
use OpenEMR\AgentForge\Http\ExtractionRequest;
use OpenEMR\AgentForge\Security\ScopedJwtClaims;
use OpenEMR\AgentForge\Security\ScopedJwtMinter;

final readonly class ExtractionDispatcher
{
    public function __construct(
        private ExtractionClient $client,
        private ScopedJwtMinter $jwtMinter,
        private SidecarPersister $sidecar,
        private UploadJobsPersister $jobs,
        private UploadJobStatusMachine $statusMachine,
    ) {
    }

    /**
     * Execute the extract + sidecar-persist pipeline.
     *
     * Flow:
     *   - Pending → Extracting via UploadJobTransition::StartExtraction
     *   - POST /extract on the agent service
     *   - On HTTP success: persist the sidecar row, then
     *     Extracting → ReadyForReview via ExtractionSucceeded.
     *   - On HTTP failure: Extracting → Failed via Fail.
     *
     * Returns true when extraction completed cleanly and the upload-job
     * is in `ready_for_review`. Returns false on any failure path.
     */
    public function dispatch(
        int $documentId,
        int $patientId,
        string $patientUuid,
        string $docType,
        string $mimeType,
        string $bytes,
        string $jobUuid,
        ScopedJwtClaims $claimsTemplate,
    ): bool {
        $this->jobs->applyTransition(
            $jobUuid,
            UploadJobStatus::Pending,
            UploadJobTransition::StartExtraction,
            $this->statusMachine,
        );

        $jwt = $this->jwtMinter->mint($claimsTemplate);

        $response = $this->client->extract(new ExtractionRequest(
            documentId: $documentId,
            patientId:  $patientId,
            docType:    $docType,
            mimeType:   $mimeType,
            bytes:      $bytes,
            jwt:        $jwt,
        ));

        if (!$response->isSuccess()) {
            $this->jobs->applyTransition(
                $jobUuid,
                UploadJobStatus::Extracting,
                UploadJobTransition::Fail,
                $this->statusMachine,
                sprintf(
                    '%s (HTTP %d): %s',
                    (string) $response->errorCode,
                    (int) $response->statusCode,
                    (string) $response->message,
                ),
            );
            return false;
        }

        $extracted     = $this->sidecar->normalizePayload($response->extracted);
        $schemaVersion = (string) $response->schemaVersion;
        $this->sidecar->persist(
            $documentId,
            $patientId,
            $docType,
            $schemaVersion,
            $extracted,
        );

        $this->jobs->applyTransition(
            $jobUuid,
            UploadJobStatus::Extracting,
            UploadJobTransition::ExtractionSucceeded,
            $this->statusMachine,
        );
        return true;
    }
}
