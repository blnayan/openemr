<?php

/**
 * Isolated tests for UploadController.
 *
 * The controller is the single explicit entry point into AgentForge
 * extraction (Document Inbox rework, issue 25). It replaces the legacy
 * `DocumentExtractionSubscriber` listener; the same boundary
 * validation surface (MIME whitelist, 10 MB cap, explicit doc_type)
 * has to be preserved structurally so the rework does not regress the
 * file-validation contract.
 *
 * These tests exercise the public boundary — the only externally
 * observable behaviour the HTTP entry point cares about:
 *
 *   - Validation: every rejection case throws `UploadValidationException`
 *     with the typed reason; the controller never silently accepts.
 *   - Happy path: source bytes are persisted via the injected document
 *     persister, an upload-job row is inserted, and extraction is
 *     dispatched with the parsed doc_type.
 *
 * Tests run without database, container, or Docker.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\AgentForge\Controller;

use Closure;
use OpenEMR\AgentForge\Controller\UploadController;
use OpenEMR\AgentForge\Controller\UploadRequest;
use OpenEMR\AgentForge\Controller\UploadValidationReason;
use OpenEMR\AgentForge\Exception\UploadValidationException;
use OpenEMR\AgentForge\Persistence\UploadJobsPersister;
use OpenEMR\AgentForge\Security\ScopedJwtClaims;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Test;
use PHPUnit\Framework\TestCase;
use Psr\Log\NullLogger;

final class UploadControllerIsolatedTest extends TestCase
{
    private const PATIENT_ID   = 17;
    private const PATIENT_UUID = 'uuid-pat-17';

    #[Test]
    public function happyPathPersistsDocumentInsertsJobAndDispatchesExtraction(): void
    {
        $jobs = $this->createMock(UploadJobsPersister::class);
        $jobs->expects(self::once())
            ->method('insertForDocument')
            ->with(909, self::PATIENT_ID, 'lab_pdf')
            ->willReturn('job-uuid-abc');

        $dispatchCalls = [];
        $dispatch = static function (int $documentId, int $patientId, string $patientUuid, string $docType, string $mimeType, string $bytes, string $jobUuid, ScopedJwtClaims $claims) use (&$dispatchCalls): bool {
            $dispatchCalls[] = compact('documentId', 'patientId', 'patientUuid', 'docType', 'mimeType', 'jobUuid');
            return true;
        };

        $persisterCalls = [];
        $persister = static function (int $pid, int $cat, string $name, string $mime, string $bytes) use (&$persisterCalls): array {
            $persisterCalls[] = ['pid' => $pid, 'cat' => $cat, 'name' => $name, 'mime' => $mime, 'size' => strlen($bytes)];
            return [909, ''];
        };

        $controller = $this->makeController($jobs, $dispatch, $persister);

        $result = $controller->handle($this->makeRequest(
            docType:  'lab_pdf',
            mimeType: 'application/pdf',
            bytes:    'BYTES',
        ));

        self::assertSame('job-uuid-abc', $result->jobUuid);
        self::assertSame(909, $result->documentId);
        self::assertSame(self::PATIENT_ID, $result->patientId);
        self::assertSame('lab_pdf', $result->docType);
        self::assertTrue($result->extractionDispatched);
        self::assertCount(1, $persisterCalls);
        self::assertSame(self::PATIENT_ID, $persisterCalls[0]['pid']);
        self::assertSame(UploadController::DEFAULT_CATEGORY_ID, $persisterCalls[0]['cat']);
        self::assertSame('application/pdf', $persisterCalls[0]['mime']);

        self::assertCount(1, $dispatchCalls);
        self::assertSame(909, $dispatchCalls[0]['documentId']);
        self::assertSame('lab_pdf', $dispatchCalls[0]['docType']);
        self::assertSame('job-uuid-abc', $dispatchCalls[0]['jobUuid']);
    }

    #[Test]
    public function intakeFormDocTypeRoutesUnchanged(): void
    {
        $jobs = $this->createMock(UploadJobsPersister::class);
        $jobs->expects(self::once())
            ->method('insertForDocument')
            ->with(self::anything(), self::anything(), 'intake_form')
            ->willReturn('job-uuid-intake');

        $observed = null;
        $dispatch = static function (int $documentId, int $patientId, string $patientUuid, string $docType, string $mimeType, string $bytes, string $jobUuid, ScopedJwtClaims $claims) use (&$observed): bool {
            $observed = $docType;
            return true;
        };

        $controller = $this->makeController(
            $jobs,
            $dispatch,
            static fn(): array => [42, ''],
        );

        $result = $controller->handle($this->makeRequest(docType: 'intake_form'));
        self::assertSame('intake_form', $result->docType);
        self::assertSame('intake_form', $observed);
    }

    #[Test]
    public function failedExtractionDispatchReturnsFalseAndLeavesJobInWriterControlledState(): void
    {
        $jobs = $this->createMock(UploadJobsPersister::class);
        $jobs->method('insertForDocument')->willReturn('job-uuid-fail');
        $jobs->expects(self::never())->method('markFailed');

        $dispatch = static fn(): bool => false;

        $controller = $this->makeController(
            $jobs,
            $dispatch,
            static fn(): array => [88, ''],
        );

        $result = $controller->handle($this->makeRequest());
        self::assertFalse($result->extractionDispatched);
    }

    #[Test]
    public function dispatchExceptionMarksJobFailedAndReturnsFalse(): void
    {
        $jobs = $this->createMock(UploadJobsPersister::class);
        $jobs->method('insertForDocument')->willReturn('job-uuid-throw');
        $jobs->expects(self::once())
            ->method('markFailed')
            ->with('job-uuid-throw', self::stringContains('extraction_dispatch_threw'));

        $dispatch = static function (): bool {
            throw new \RuntimeException('agent down');
        };

        $controller = $this->makeController(
            $jobs,
            $dispatch,
            static fn(): array => [55, ''],
        );

        $result = $controller->handle($this->makeRequest());
        self::assertFalse($result->extractionDispatched);
    }

    // -----------------------------------------------------------------
    // Soft duplicate-warning advisory
    // -----------------------------------------------------------------

    #[Test]
    public function duplicateUploadSurfacesPriorJobUuidWithoutBlocking(): void
    {
        // Persister reports a prior committed upload with the same SHA-256.
        // The controller MUST still complete the upload (no exception, no
        // skipped insert) but surface the duplicate hint on the result so
        // the inbox UI can render an advisory banner.
        $bytes = 'PDF-PAYLOAD-V1';
        $expectedHash = hash('sha256', $bytes);

        $jobs = $this->createMock(UploadJobsPersister::class);
        $jobs->expects(self::once())
            ->method('findCommittedDuplicate')
            ->with(self::PATIENT_ID, $expectedHash)
            ->willReturn([
                'job_uuid'     => 'prior-job-uuid',
                'filename'     => 'p01-chen-lipid-panel.pdf',
                'committed_at' => '2026-05-07 20:23:00',
            ]);
        $jobs->expects(self::once())
            ->method('insertForDocument')
            // Hash is forwarded to the persister as the 5th arg so the
            // current upload's job carries it for future lookups.
            ->with(909, self::PATIENT_ID, 'lab_pdf', self::anything(), $expectedHash)
            ->willReturn('current-job-uuid');

        $controller = $this->makeController(
            $jobs,
            static fn(): bool => true,
            static fn(): array => [909, ''],
        );

        $result = $controller->handle($this->makeRequest(
            docType:  'lab_pdf',
            mimeType: 'application/pdf',
            bytes:    $bytes,
        ));

        self::assertSame('current-job-uuid', $result->jobUuid);
        self::assertTrue($result->extractionDispatched, 'duplicate is advisory only — extraction still ran');
        self::assertSame('prior-job-uuid', $result->duplicateOfJobUuid);
        self::assertSame('p01-chen-lipid-panel.pdf', $result->duplicateOfFilename);
        self::assertSame('2026-05-07 20:23:00', $result->duplicateCommittedAt);
    }

    #[Test]
    public function noDuplicateLeavesAdvisoryFieldsNull(): void
    {
        $jobs = $this->createMock(UploadJobsPersister::class);
        $jobs->method('findCommittedDuplicate')->willReturn(null);
        $jobs->method('insertForDocument')->willReturn('fresh-job-uuid');

        $controller = $this->makeController(
            $jobs,
            static fn(): bool => true,
            static fn(): array => [101, ''],
        );

        $result = $controller->handle($this->makeRequest());

        self::assertNull($result->duplicateOfJobUuid);
        self::assertNull($result->duplicateOfFilename);
        self::assertNull($result->duplicateCommittedAt);
    }

    #[Test]
    public function uploadPersistsHashEvenWhenNoPriorMatch(): void
    {
        // Locks in the contract: the SHA-256 is forwarded on EVERY
        // upload (not just on duplicate hits), so the next upload of
        // the same bytes can find this row in `findCommittedDuplicate`.
        $bytes = 'TOTALLY-NEW-CONTENT';
        $expected = hash('sha256', $bytes);

        $jobs = $this->createMock(UploadJobsPersister::class);
        $jobs->method('findCommittedDuplicate')->willReturn(null);
        $jobs->expects(self::once())
            ->method('insertForDocument')
            ->with(self::anything(), self::PATIENT_ID, 'lab_pdf', self::anything(), $expected)
            ->willReturn('uuid-fresh');

        $controller = $this->makeController(
            $jobs,
            static fn(): bool => true,
            static fn(): array => [202, ''],
        );

        $controller->handle($this->makeRequest(bytes: $bytes));
    }

    #[Test]
    public function documentPersisterReturningErrorAbortsBeforeJobInsert(): void
    {
        $jobs = $this->createMock(UploadJobsPersister::class);
        $jobs->expects(self::never())->method('insertForDocument');

        $dispatchCalls = 0;
        $dispatch = static function () use (&$dispatchCalls): bool {
            $dispatchCalls++;
            return true;
        };

        $controller = $this->makeController(
            $jobs,
            $dispatch,
            static fn(): array => [0, 'disk full'],
        );

        try {
            $controller->handle($this->makeRequest());
            self::fail('expected RuntimeException');
        } catch (\RuntimeException) {
            // expected
        }
        self::assertSame(0, $dispatchCalls);
    }

    /**
     * @return iterable<string, array{string, string, string, UploadValidationReason}>
     *
     * @codeCoverageIgnore Data providers run before coverage instrumentation starts.
     */
    public static function rejectionProvider(): iterable
    {
        yield 'unknown doc_type' => [
            'audio_recording', 'application/pdf', 'BYTES',
            UploadValidationReason::InvalidDocType,
        ];
        yield 'empty doc_type' => [
            '', 'application/pdf', 'BYTES',
            UploadValidationReason::InvalidDocType,
        ];
        yield 'unsupported MIME (HTML)' => [
            'lab_pdf', 'text/html', 'BYTES',
            UploadValidationReason::UnsupportedMimeType,
        ];
        yield 'unsupported MIME (octet-stream)' => [
            'lab_pdf', 'application/octet-stream', 'BYTES',
            UploadValidationReason::UnsupportedMimeType,
        ];
        yield 'empty MIME' => [
            'lab_pdf', '', 'BYTES',
            UploadValidationReason::UnsupportedMimeType,
        ];
        yield 'empty payload' => [
            'lab_pdf', 'application/pdf', '',
            UploadValidationReason::EmptyPayload,
        ];
        yield 'oversized payload' => [
            'lab_pdf', 'application/pdf',
            str_repeat('A', UploadController::MAX_BYTES + 1),
            UploadValidationReason::OversizedPayload,
        ];
    }

    #[Test]
    #[DataProvider('rejectionProvider')]
    public function rejectsInvalidUploadAtBoundary(
        string $docType,
        string $mimeType,
        string $bytes,
        UploadValidationReason $expectedReason,
    ): void {
        $jobs = $this->createMock(UploadJobsPersister::class);
        $jobs->expects(self::never())->method('insertForDocument');

        $dispatchCalls = 0;
        $dispatch = static function () use (&$dispatchCalls): bool {
            $dispatchCalls++;
            return true;
        };

        $controller = $this->makeController(
            $jobs,
            $dispatch,
            static fn(): array => [1, ''],
        );

        try {
            $controller->handle($this->makeRequest(
                docType:  $docType,
                mimeType: $mimeType,
                bytes:    $bytes,
            ));
            self::fail('expected UploadValidationException');
        } catch (UploadValidationException $e) {
            self::assertSame($expectedReason, $e->reason);
        }
        self::assertSame(0, $dispatchCalls);
    }

    #[Test]
    public function rejectsInvalidPatientContext(): void
    {
        $jobs = $this->createMock(UploadJobsPersister::class);
        $dispatch = static fn(): bool => true;
        $controller = $this->makeController(
            $jobs,
            $dispatch,
            static fn(): array => [1, ''],
        );

        $req = new UploadRequest(
            patientId:    0,
            patientUuid:  '',
            docType:      'lab_pdf',
            filename:     'lab.pdf',
            mimeType:     'application/pdf',
            bytes:        'BYTES',
            authUser:     'admin',
            authProvider: 'Default',
            authRole:     '',
            sessionId:    'sess-1',
        );

        try {
            $controller->handle($req);
            self::fail('expected UploadValidationException');
        } catch (UploadValidationException $e) {
            self::assertSame(UploadValidationReason::InvalidPatient, $e->reason);
        }
    }

    /**
     * @param Closure(int, int, string, string, string, string, string, ScopedJwtClaims): bool $dispatch
     * @param Closure(int, int, string, string, string): array{0: int, 1: string} $persister
     */
    private function makeController(
        UploadJobsPersister $jobs,
        Closure $dispatch,
        Closure $persister,
    ): UploadController {
        return new UploadController(
            jobs:               $jobs,
            logger:             new NullLogger(),
            documentPersister:  $persister,
            extractionDispatch: $dispatch,
        );
    }

    private function makeRequest(
        string $docType = 'lab_pdf',
        string $mimeType = 'application/pdf',
        string $bytes = 'BYTES',
    ): UploadRequest {
        return new UploadRequest(
            patientId:    self::PATIENT_ID,
            patientUuid:  self::PATIENT_UUID,
            docType:      $docType,
            filename:     'sample.pdf',
            mimeType:     $mimeType,
            bytes:        $bytes,
            authUser:     'admin',
            authProvider: 'Default',
            authRole:     '1',
            sessionId:    'sess-1',
        );
    }
}
