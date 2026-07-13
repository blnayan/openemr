<?php

/**
 * UploadController — single HTTP entry point into AgentForge extraction.
 *
 * Replaces the legacy {@see DocumentExtractionSubscriber} listener that
 * keyed off the AgentForge document categories. The Document Inbox tab
 * posts a multipart upload here; the controller validates the boundary,
 * persists source bytes via {@see \Document::createDocument()} so the
 * file round-trips into OpenEMR's canonical `documents` table, inserts
 * the upload-job row, and dispatches extraction synchronously through
 * the existing {@see ExtractionDispatcher}.
 *
 * Validation enforced at the boundary (mirrors the legacy listener so
 * the file-validation surface does not regress):
 *   - MIME whitelist: application/pdf, image/png, image/jpeg, image/webp.
 *   - 10 MB size cap (`MAX_BYTES`).
 *   - doc_type is an explicit `lab_pdf` or `intake_form` form field —
 *     no category-name substring inference.
 *   - Non-empty payload, non-empty filename, positive patient id.
 *
 * Authorization: the HTTP entry point runs `aclCheckCore('patients',
 * 'docs', '', 'write')` BEFORE constructing this controller. Endpoint
 * documentation:
 *   - read sub-privilege governs visibility of the inbox page.
 *   - write sub-privilege governs upload + confirm + reject.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\AgentForge\Controller;

use Closure;
use OpenEMR\AgentForge\Domain\DocType;
use OpenEMR\AgentForge\Exception\UploadValidationException;
use OpenEMR\AgentForge\Http\ExtractionClient;
use OpenEMR\AgentForge\Persistence\ExtractionDispatcher;
use OpenEMR\AgentForge\Persistence\UploadJobsPersister;
use OpenEMR\AgentForge\Security\ScopedJwtClaims;
use OpenEMR\AgentForge\Security\ScopedJwtMinter;
use Psr\Clock\ClockInterface;
use Psr\Log\LoggerInterface;

final readonly class UploadController
{
    public const MAX_BYTES = 10 * 1024 * 1024; // 10 MB — same cap the legacy listener enforced.

    /**
     * Allowed MIME types. Mirrors {@see DocumentExtractionSubscriber}'s
     * legacy whitelist verbatim so the upload surface does not regress.
     */
    public const ALLOWED_MIME_TYPES = [
        'application/pdf',
        'image/png',
        'image/jpeg',
        'image/webp',
    ];

    /**
     * Document category id used for round-trip into the canonical
     * Documents tab. The "Medical Record" leaf (id 3 in the bundled
     * schema) is the closest generic bucket; the AgentForge subtree was
     * removed by migration `20260506130002`. Round-trip integrity is
     * what the PRD requires here, not categorization.
     */
    public const DEFAULT_CATEGORY_ID = 3;

    /**
     * @param Closure(int $patientId, int $categoryId, string $filename, string $mimeType, string $bytes): array{0: int, 1: string} $documentPersister
     *        Wraps {@see \Document::createDocument()} so the controller is unit-testable
     *        without the legacy `Document` class. Returns `[documentId, error]`;
     *        a non-empty error string aborts the upload.
     * @param Closure(int $documentId, int $patientId, string $patientUuid, string $docType, string $mimeType, string $bytes, string $jobUuid, ScopedJwtClaims $claims): bool $extractionDispatch
     *        Runs the extract → sidecar persist → status-transition pipeline.
     *        In production this binds to {@see ExtractionDispatcher::dispatch()};
     *        tests substitute a closure so they do not need to mock the
     *        `final readonly` dispatcher class.
     */
    public function __construct(
        private UploadJobsPersister $jobs,
        private LoggerInterface $logger,
        private Closure $documentPersister,
        private Closure $extractionDispatch,
    ) {
    }

    /**
     * Run the upload. Validation failures throw
     * {@see UploadValidationException}; transport / persistence
     * failures propagate as runtime exceptions for the HTTP entry point
     * to translate to 5xx.
     *
     * @throws UploadValidationException
     * @throws \RuntimeException when the document persister returns an error
     */
    public function handle(UploadRequest $request): UploadResult
    {
        $docType = $this->parseDocType($request->docType);
        $this->assertValidPayload($request);

        // SHA-256 of the upload bytes drives both:
        //   1. The duplicate-warning lookup BEFORE we write anything
        //      (advisory, no block).
        //   2. The hash column on agentforge_upload_jobs so the next
        //      upload of the same bytes can find this job.
        $fileHash = hash('sha256', $request->bytes);
        $duplicate = $this->jobs->findCommittedDuplicate($request->patientId, $fileHash);

        [$documentId, $error] = $this->persistDocument($request);
        if ($error !== '' || $documentId <= 0) {
            throw new \RuntimeException(
                'Document::createDocument failed for AgentForge upload (patient_id='
                . $request->patientId . ')'
            );
        }

        $jobUuid = $this->jobs->insertForDocument(
            $documentId,
            $request->patientId,
            $docType->value,
            $request->jobUuid,
            $fileHash,
        );

        $this->logger->info('AgentForge upload accepted', [
            'job_uuid'    => $jobUuid,
            'document_id' => $documentId,
            'patient_id'  => $request->patientId,
            'doc_type'    => $docType->value,
            'mime_type'   => $request->mimeType,
            'size_bytes'  => strlen($request->bytes),
            'duplicate_of' => $duplicate['job_uuid'] ?? null,
        ]);

        $dispatched = $this->dispatchExtraction($request, $docType, $documentId, $jobUuid);

        return new UploadResult(
            jobUuid:               $jobUuid,
            documentId:            $documentId,
            patientId:             $request->patientId,
            docType:               $docType->value,
            extractionDispatched:  $dispatched,
            duplicateOfJobUuid:    $duplicate['job_uuid'] ?? null,
            duplicateOfFilename:   $duplicate['filename'] ?? null,
            duplicateCommittedAt:  $duplicate['committed_at'] ?? null,
        );
    }

    /**
     * @throws UploadValidationException
     */
    private function parseDocType(string $value): DocType
    {
        $parsed = DocType::tryFrom($value);
        if ($parsed === null) {
            throw new UploadValidationException(
                UploadValidationReason::InvalidDocType,
                sprintf(
                    'doc_type must be one of %s; got %s',
                    implode(', ', array_map(static fn (DocType $d): string => $d->value, DocType::cases())),
                    $value === '' ? '<empty>' : $value,
                ),
            );
        }
        return $parsed;
    }

    /**
     * @throws UploadValidationException
     */
    private function assertValidPayload(UploadRequest $request): void
    {
        if ($request->patientId <= 0 || $request->patientUuid === '') {
            throw new UploadValidationException(
                UploadValidationReason::InvalidPatient,
                'upload requires an authenticated patient context',
            );
        }
        if (!in_array($request->mimeType, self::ALLOWED_MIME_TYPES, true)) {
            throw new UploadValidationException(
                UploadValidationReason::UnsupportedMimeType,
                sprintf(
                    'unsupported MIME type %s; expected one of %s',
                    $request->mimeType === '' ? '<empty>' : $request->mimeType,
                    implode(', ', self::ALLOWED_MIME_TYPES),
                ),
            );
        }
        $size = strlen($request->bytes);
        if ($size === 0 || $request->filename === '') {
            throw new UploadValidationException(
                UploadValidationReason::EmptyPayload,
                'upload payload must be a named, non-empty file',
            );
        }
        if ($size > self::MAX_BYTES) {
            throw new UploadValidationException(
                UploadValidationReason::OversizedPayload,
                sprintf(
                    'upload of %d bytes exceeds %d-byte cap',
                    $size,
                    self::MAX_BYTES,
                ),
            );
        }
    }

    /**
     * @return array{0: int, 1: string}
     */
    private function persistDocument(UploadRequest $request): array
    {
        return ($this->documentPersister)(
            $request->patientId,
            self::DEFAULT_CATEGORY_ID,
            $request->filename,
            $request->mimeType,
            $request->bytes,
        );
    }

    /**
     * Dispatch extraction synchronously. Failures inside the dispatcher
     * already transition the upload-job to `failed`; we log and return
     * the tristate so the HTTP entry point can surface a clear status
     * to the inbox UI.
     */
    private function dispatchExtraction(
        UploadRequest $request,
        DocType $docType,
        int $documentId,
        string $jobUuid,
    ): bool {
        $claims = new ScopedJwtClaims(
            userId:      $request->authUser,
            groupname:   $request->authProvider,
            role:        $request->authRole,
            pid:         $request->patientId,
            patientUuid: $request->patientUuid,
            encounterId: null,
            sessionId:   $request->sessionId,
            scope:       ScopedJwtMinter::SCOPE,
        );

        try {
            return ($this->extractionDispatch)(
                $documentId,
                $request->patientId,
                $request->patientUuid,
                $docType->value,
                $request->mimeType,
                $request->bytes,
                $jobUuid,
                $claims,
            );
        } catch (\RuntimeException | \InvalidArgumentException | \LogicException | \JsonException $e) {
            // The dispatcher's own catch markets the job as failed; if
            // that path also threw, fall back to markFailed() so the UI
            // sees a terminal state rather than a stuck `pending`.
            $this->logger->error('AgentForge extraction dispatch threw', [
                'job_uuid'    => $jobUuid,
                'document_id' => $documentId,
                'patient_id'  => $request->patientId,
                'exception'   => $e,
            ]);
            try {
                $this->jobs->markFailed(
                    $jobUuid,
                    'extraction_dispatch_threw: ' . $e->getMessage(),
                );
            } catch (\RuntimeException | \InvalidArgumentException | \LogicException $jobErr) {
                $this->logger->error('AgentForge: failed to mark upload-job failed', [
                    'job_uuid'  => $jobUuid,
                    'exception' => $jobErr,
                ]);
            }
            return false;
        }
    }

    /**
     * Production document-persister closure: thin wrapper over
     * {@see \Document::createDocument()} that returns the
     * `[documentId, error]` tuple this controller's constructor type
     * requires.
     *
     * @return Closure(int, int, string, string, string): array{0: int, 1: string}
     */
    public static function defaultDocumentPersister(): Closure
    {
        return static function (
            int $patientId,
            int $categoryId,
            string $filename,
            string $mimeType,
            string $bytes,
        ): array {
            $doc = new \Document();
            // createDocument() takes its bytes by reference; assign to a
            // local before passing so the controller's caller is never
            // surprised by mutation of $bytes.
            $local = $bytes;
            $error = (string) $doc->createDocument(
                (string) $patientId,
                $categoryId,
                $filename,
                $mimeType,
                $local,
            );
            $idRaw = $doc->get_id();
            $documentId = is_int($idRaw) ? $idRaw
                : (is_string($idRaw) && ctype_digit($idRaw) ? (int) $idRaw : 0);
            return [$documentId, $error];
        };
    }

    /**
     * Build the HTTP-extraction wiring for the upload controller. Pulls
     * configuration from env, mirrors the JWT shape of the legacy
     * subscriber, and calls the agent service via the existing
     * {@see ExtractionClient}.
     *
     * Returns a `[$dispatchCallable, $minter]` tuple. The callable
     * forwards to {@see ExtractionDispatcher::dispatch()} with the
     * shape {@see UploadController::__construct()} expects, keeping the
     * controller independent of the (final readonly) dispatcher class
     * for unit-test purposes.
     *
     * @return array{0: Closure(int, int, string, string, string, string, string, ScopedJwtClaims): bool, 1: ScopedJwtMinter}
     *
     * @throws \RuntimeException when the agent service is not configured.
     */
    public static function defaultExtractionWiring(
        UploadJobsPersister $jobs,
        \OpenEMR\AgentForge\Persistence\SidecarPersister $sidecar,
        \OpenEMR\AgentForge\Domain\UploadJobStatusMachine $statusMachine,
        ClockInterface $clock,
    ): array {
        $secretRaw     = $_ENV['AGENTFORGE_JWT_SECRET'] ?? getenv('AGENTFORGE_JWT_SECRET');
        $serviceUrlRaw = $_ENV['AGENTFORGE_SERVICE_URL'] ?? getenv('AGENTFORGE_SERVICE_URL');
        $secret        = is_string($secretRaw) ? $secretRaw : '';
        $serviceUrl    = is_string($serviceUrlRaw) ? $serviceUrlRaw : '';
        if ($secret === '' || $serviceUrl === '') {
            throw new \RuntimeException('AgentForge agent service is not configured');
        }
        $client = new ExtractionClient($serviceUrl);
        $minter = new ScopedJwtMinter($secret, $clock);
        $dispatcher = new ExtractionDispatcher(
            client:        $client,
            jwtMinter:     $minter,
            sidecar:       $sidecar,
            jobs:          $jobs,
            statusMachine: $statusMachine,
        );
        $dispatch = static fn(
            int $documentId,
            int $patientId,
            string $patientUuid,
            string $docType,
            string $mimeType,
            string $bytes,
            string $jobUuid,
            ScopedJwtClaims $claims,
        ): bool => $dispatcher->dispatch(
            documentId:     $documentId,
            patientId:      $patientId,
            patientUuid:    $patientUuid,
            docType:        $docType,
            mimeType:       $mimeType,
            bytes:          $bytes,
            jobUuid:        $jobUuid,
            claimsTemplate: $claims,
        );
        return [$dispatch, $minter];
    }
}
