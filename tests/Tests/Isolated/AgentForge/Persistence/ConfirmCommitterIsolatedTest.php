<?php

/**
 * Isolated tests for ConfirmCommitter.
 *
 * Covers the four behaviors the issue lists explicitly:
 *   1. doc_type routing to the correct writer in the writer map
 *   2. double-confirm rejection (status not in ready_for_review →
 *      typed exception the HTTP layer maps to 409)
 *   3. status transitions on success (Confirm) and on whole-document
 *      reject (Reject), going through UploadJobStatusMachine
 *   4. provenance stamping on the sidecar (reviewer id, timestamp,
 *      review_decision, edited_field_paths)
 *
 * Tests run without database, container, or Docker: persister
 * collaborators are PHPUnit mocks, the writer map carries
 * inline-defined fakes, and the status machine is exercised
 * end-to-end (it has no I/O of its own).
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\AgentForge\Persistence;

use OpenEMR\AgentForge\Domain\UploadJobStatus;
use OpenEMR\AgentForge\Domain\UploadJobStatusMachine;
use OpenEMR\AgentForge\Domain\UploadJobTransition;
use OpenEMR\AgentForge\Exception\UnknownDocTypeException;
use OpenEMR\AgentForge\Exception\UploadJobNotReadyForReviewException;
use OpenEMR\AgentForge\Persistence\ConfirmCommitter;
use OpenEMR\AgentForge\Persistence\DocumentWriter;
use OpenEMR\AgentForge\Persistence\ExtractionRow;
use OpenEMR\AgentForge\Persistence\IntakeWriteOutcome;
use OpenEMR\AgentForge\Persistence\LabFhirWriter;
use OpenEMR\AgentForge\Persistence\LabWriteOutcome;
use OpenEMR\AgentForge\Persistence\SidecarPersister;
use OpenEMR\AgentForge\Persistence\UploadJobRow;
use OpenEMR\AgentForge\Persistence\UploadJobsPersister;
use OpenEMR\AgentForge\Persistence\WriteOutcome;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Test;
use PHPUnit\Framework\TestCase;

final class ConfirmCommitterIsolatedTest extends TestCase
{
    private const JOB_UUID  = 'test-job-0001';
    private const DOC_ID    = 4242;
    private const PID       = 17;
    private const EXTR_ID   = 91;
    private const USER_ID   = 5;

    #[Test]
    public function confirmRoutesByDocTypeToTheRegisteredWriter(): void
    {
        $intakeWriter = $this->makeRecordingWriter(new LabWriteOutcome(2, 0, []));
        $job          = $this->jobIn(UploadJobStatus::ReadyForReview, 'intake_form');
        $extraction   = $this->extractionRow(['allergies' => [['name' => 'penicillin']]]);

        $jobs    = $this->mockJobsPersister($job, expectTransition: UploadJobTransition::Confirm);
        $sidecar = $this->mockSidecarPersister($extraction, expectStamp: SidecarPersister::REVIEW_DECISION_COMMITTED);

        $committer = new ConfirmCommitter(
            labWriter:        $this->makeStubLabWriter(),
            writersByDocType: ['intake_form' => $intakeWriter],
            jobs:             $jobs,
            sidecar:          $sidecar,
            statusMachine:    new UploadJobStatusMachine(),
        );

        $outcome = $committer->confirm(self::JOB_UUID, ['allergies' => [['name' => 'penicillin']]], self::USER_ID);

        self::assertSame(2, $outcome->totalRows());
        self::assertSame(1, $intakeWriter->callCount());
        $args = $intakeWriter->lastCall();
        self::assertSame(self::EXTR_ID, $args['extractionId']);
        self::assertSame(self::PID, $args['patientId']);
        self::assertSame(self::DOC_ID, $args['documentId']);
        self::assertSame(['allergies' => [['name' => 'penicillin']]], $args['extracted']);
    }

    #[Test]
    public function confirmRoutesLabPdfToTheLabWriterPinnedConstructorArg(): void
    {
        $labWriter = $this->createMock(LabFhirWriter::class);
        $labWriter->expects(self::once())
            ->method('writeThrough')
            ->with(self::EXTR_ID, self::PID, self::DOC_ID, ['results' => []])
            ->willReturn(new LabWriteOutcome(0, 0, []));

        $job        = $this->jobIn(UploadJobStatus::ReadyForReview, 'lab_pdf');
        $extraction = $this->extractionRow(['results' => []]);

        $jobs    = $this->mockJobsPersister($job, expectTransition: UploadJobTransition::Confirm);
        $sidecar = $this->mockSidecarPersister($extraction, expectStamp: SidecarPersister::REVIEW_DECISION_COMMITTED);

        $committer = new ConfirmCommitter(
            labWriter:        $labWriter,
            writersByDocType: [],
            jobs:             $jobs,
            sidecar:          $sidecar,
            statusMachine:    new UploadJobStatusMachine(),
        );

        $committer->confirm(self::JOB_UUID, ['results' => []], self::USER_ID);
    }

    #[Test]
    public function confirmThrows409TypedExceptionWhenStatusIsNotReadyForReview(): void
    {
        $job = $this->jobIn(UploadJobStatus::Committed, 'lab_pdf');

        $jobs = $this->createMock(UploadJobsPersister::class);
        $jobs->expects(self::once())
            ->method('loadJob')
            ->with(self::JOB_UUID)
            ->willReturn($job);
        $jobs->expects(self::never())->method('applyTransition');

        $sidecar = $this->createMock(SidecarPersister::class);
        $sidecar->expects(self::never())->method('loadByDocumentId');
        $sidecar->expects(self::never())->method('stampReview');
        $sidecar->expects(self::never())->method('updateExtractedJson');

        $writer = $this->makeRecordingWriter(new LabWriteOutcome(0, 0, []));

        $committer = new ConfirmCommitter(
            labWriter:        $this->makeStubLabWriter(),
            writersByDocType: ['intake_form' => $writer],
            jobs:             $jobs,
            sidecar:          $sidecar,
            statusMachine:    new UploadJobStatusMachine(),
        );

        try {
            $committer->confirm(self::JOB_UUID, ['x' => 1], self::USER_ID);
            self::fail('expected UploadJobNotReadyForReviewException');
        } catch (UploadJobNotReadyForReviewException $e) {
            self::assertSame(self::JOB_UUID, $e->jobUuid);
            self::assertSame(UploadJobStatus::Committed, $e->currentStatus);
            self::assertSame(0, $writer->callCount());
        }
    }

    /**
     * @return iterable<string, array{UploadJobStatus}>
     *
     * @codeCoverageIgnore Data providers run before coverage instrumentation starts.
     */
    public static function nonReadyStatusProvider(): iterable
    {
        yield 'pending'  => [UploadJobStatus::Pending];
        yield 'extracting' => [UploadJobStatus::Extracting];
        yield 'committed' => [UploadJobStatus::Committed];
        yield 'rejected'  => [UploadJobStatus::Rejected];
        yield 'failed'    => [UploadJobStatus::Failed];
    }

    #[Test]
    #[DataProvider('nonReadyStatusProvider')]
    public function confirmThrowsForEveryNonReadyStatus(UploadJobStatus $status): void
    {
        $job = $this->jobIn($status, 'lab_pdf');

        $jobs = $this->createMock(UploadJobsPersister::class);
        $jobs->method('loadJob')->willReturn($job);

        $sidecar = $this->createMock(SidecarPersister::class);

        $committer = new ConfirmCommitter(
            labWriter:        $this->makeStubLabWriter(),
            writersByDocType: [],
            jobs:             $jobs,
            sidecar:          $sidecar,
            statusMachine:    new UploadJobStatusMachine(),
        );

        $this->expectException(UploadJobNotReadyForReviewException::class);
        $committer->confirm(self::JOB_UUID, [], self::USER_ID);
    }

    #[Test]
    public function confirmThrowsWhenJobIsMissing(): void
    {
        $jobs = $this->createMock(UploadJobsPersister::class);
        $jobs->method('loadJob')->willReturn(null);

        $sidecar = $this->createMock(SidecarPersister::class);

        $committer = new ConfirmCommitter(
            labWriter:        $this->makeStubLabWriter(),
            writersByDocType: [],
            jobs:             $jobs,
            sidecar:          $sidecar,
            statusMachine:    new UploadJobStatusMachine(),
        );

        $this->expectException(UploadJobNotReadyForReviewException::class);
        $committer->confirm('nonexistent-uuid', [], self::USER_ID);
    }

    #[Test]
    public function confirmStampsReviewerProvenanceWithEditedFieldPaths(): void
    {
        $original = ['header' => ['ordering_provider' => 'Dr. Smith'], 'results' => []];
        $edited   = ['header' => ['ordering_provider' => 'Dr. SMITH'], 'results' => []];

        $job        = $this->jobIn(UploadJobStatus::ReadyForReview, 'lab_pdf');
        $extraction = $this->extractionRow($original);

        $writer = $this->createMock(LabFhirWriter::class);
        $writer->method('writeThrough')->willReturn(new LabWriteOutcome(0, 0, []));

        $jobs    = $this->mockJobsPersister($job, expectTransition: UploadJobTransition::Confirm);
        $sidecar = $this->createMock(SidecarPersister::class);
        $sidecar->method('loadByDocumentId')->willReturn($extraction);
        $sidecar->expects(self::once())
            ->method('updateExtractedJson')
            ->with(self::EXTR_ID, $edited);
        $sidecar->expects(self::once())
            ->method('stampReview')
            ->with(
                self::EXTR_ID,
                self::USER_ID,
                SidecarPersister::REVIEW_DECISION_COMMITTED,
                ['header.ordering_provider'],
            );

        $committer = new ConfirmCommitter(
            labWriter:        $writer,
            writersByDocType: [],
            jobs:             $jobs,
            sidecar:          $sidecar,
            statusMachine:    new UploadJobStatusMachine(),
        );

        $committer->confirm(self::JOB_UUID, $edited, self::USER_ID);
    }

    #[Test]
    public function confirmStampsEmptyEditedFieldPathsWhenReviewerMadeNoChanges(): void
    {
        $payload = ['header' => ['ordering_provider' => 'Dr. Smith'], 'results' => []];

        $job        = $this->jobIn(UploadJobStatus::ReadyForReview, 'lab_pdf');
        $extraction = $this->extractionRow($payload);

        $writer = $this->createMock(LabFhirWriter::class);
        $writer->method('writeThrough')->willReturn(new LabWriteOutcome(0, 0, []));

        $jobs    = $this->mockJobsPersister($job, expectTransition: UploadJobTransition::Confirm);
        $sidecar = $this->createMock(SidecarPersister::class);
        $sidecar->method('loadByDocumentId')->willReturn($extraction);
        $sidecar->expects(self::once())
            ->method('stampReview')
            ->with(self::EXTR_ID, self::USER_ID, SidecarPersister::REVIEW_DECISION_COMMITTED, []);

        $committer = new ConfirmCommitter(
            labWriter:        $writer,
            writersByDocType: [],
            jobs:             $jobs,
            sidecar:          $sidecar,
            statusMachine:    new UploadJobStatusMachine(),
        );

        $committer->confirm(self::JOB_UUID, $payload, self::USER_ID);
    }

    #[Test]
    public function confirmThrowsUnknownDocTypeWhenWriterMapHasNoEntry(): void
    {
        $job        = $this->jobIn(UploadJobStatus::ReadyForReview, 'unknown_type');
        $extraction = $this->extractionRow(['x' => 1]);

        $jobs = $this->createMock(UploadJobsPersister::class);
        $jobs->method('loadJob')->willReturn($job);
        $jobs->expects(self::never())->method('applyTransition');

        $sidecar = $this->createMock(SidecarPersister::class);
        $sidecar->method('loadByDocumentId')->willReturn($extraction);
        $sidecar->expects(self::never())->method('stampReview');

        $committer = new ConfirmCommitter(
            labWriter:        $this->makeStubLabWriter(),
            writersByDocType: [],
            jobs:             $jobs,
            sidecar:          $sidecar,
            statusMachine:    new UploadJobStatusMachine(),
        );

        try {
            $committer->confirm(self::JOB_UUID, ['x' => 1], self::USER_ID);
            self::fail('expected UnknownDocTypeException');
        } catch (UnknownDocTypeException $e) {
            self::assertSame('unknown_type', $e->docType);
        }
    }

    #[Test]
    public function rejectStampsRejectedProvenanceAndTransitionsWithoutCallingAnyWriter(): void
    {
        $job        = $this->jobIn(UploadJobStatus::ReadyForReview, 'lab_pdf');
        $extraction = $this->extractionRow(['results' => []]);

        $labWriter = $this->createMock(LabFhirWriter::class);
        $labWriter->expects(self::never())->method('writeThrough');

        $intakeWriter = $this->makeRecordingWriter(new LabWriteOutcome(0, 0, []));

        $jobs    = $this->mockJobsPersister($job, expectTransition: UploadJobTransition::Reject);
        $sidecar = $this->createMock(SidecarPersister::class);
        $sidecar->method('loadByDocumentId')->willReturn($extraction);
        $sidecar->expects(self::never())->method('updateExtractedJson');
        $sidecar->expects(self::once())
            ->method('stampReview')
            ->with(
                self::EXTR_ID,
                self::USER_ID,
                SidecarPersister::REVIEW_DECISION_REJECTED,
                null,
            );

        $committer = new ConfirmCommitter(
            labWriter:        $labWriter,
            writersByDocType: ['intake_form' => $intakeWriter],
            jobs:             $jobs,
            sidecar:          $sidecar,
            statusMachine:    new UploadJobStatusMachine(),
        );

        $committer->reject(self::JOB_UUID, self::USER_ID);

        self::assertSame(0, $intakeWriter->callCount());
    }

    #[Test]
    public function rejectThrowsWhenStatusIsNotReadyForReview(): void
    {
        $job = $this->jobIn(UploadJobStatus::Rejected, 'lab_pdf');

        $jobs = $this->createMock(UploadJobsPersister::class);
        $jobs->method('loadJob')->willReturn($job);
        $jobs->expects(self::never())->method('applyTransition');

        $sidecar = $this->createMock(SidecarPersister::class);
        $sidecar->expects(self::never())->method('stampReview');

        $committer = new ConfirmCommitter(
            labWriter:        $this->makeStubLabWriter(),
            writersByDocType: [],
            jobs:             $jobs,
            sidecar:          $sidecar,
            statusMachine:    new UploadJobStatusMachine(),
        );

        $this->expectException(UploadJobNotReadyForReviewException::class);
        $committer->reject(self::JOB_UUID, self::USER_ID);
    }

    #[Test]
    public function confirmForwardsPartialFailureSummaryAsErrorMessageOnTheCommittedTransition(): void
    {
        $partialOutcome = new IntakeWriteOutcome(
            medicationSuccesses:   1,
            medicationFailures:    1,
            medicationErrors:      [1 => 'SQL insert failed'],
            allergySuccesses:      0,
            allergyFailures:       0,
            allergyErrors:         [],
            chiefConcernSuccesses: 0,
            chiefConcernFailures:  0,
            chiefConcernError:     null,
        );

        $writer = $this->makeRecordingWriter($partialOutcome);
        $job        = $this->jobIn(UploadJobStatus::ReadyForReview, 'intake_form');
        $extraction = $this->extractionRow(['current_medications' => []]);

        $jobs = $this->mockJobsPersister(
            $job,
            expectTransition:      UploadJobTransition::Confirm,
            expectedErrorMessage:  'partial: 1 medication(s) failed',
        );
        $sidecar = $this->mockSidecarPersister($extraction, expectStamp: SidecarPersister::REVIEW_DECISION_COMMITTED);

        $committer = new ConfirmCommitter(
            labWriter:        $this->makeStubLabWriter(),
            writersByDocType: ['intake_form' => $writer],
            jobs:             $jobs,
            sidecar:          $sidecar,
            statusMachine:    new UploadJobStatusMachine(),
        );

        $committer->confirm(self::JOB_UUID, ['current_medications' => []], self::USER_ID);
    }

    #[Test]
    public function confirmTransitionsThroughTheStatusMachineEndingInCommitted(): void
    {
        $captured = null;
        $jobs = $this->createMock(UploadJobsPersister::class);
        $jobs->method('loadJob')->willReturn($this->jobIn(UploadJobStatus::ReadyForReview, 'lab_pdf'));
        $jobs->expects(self::once())
            ->method('applyTransition')
            ->with(
                self::JOB_UUID,
                UploadJobStatus::ReadyForReview,
                UploadJobTransition::Confirm,
                self::isInstanceOf(UploadJobStatusMachine::class),
                null,
            )
            ->willReturnCallback(static function (string $uuid, UploadJobStatus $current, UploadJobTransition $t, UploadJobStatusMachine $m, ?string $errorMessage) use (&$captured): UploadJobStatus {
                $captured = $m->next($current, $t);
                return $captured;
            });

        $sidecar = $this->createMock(SidecarPersister::class);
        $sidecar->method('loadByDocumentId')->willReturn($this->extractionRow([]));

        $writer = $this->createMock(LabFhirWriter::class);
        $writer->method('writeThrough')->willReturn(new LabWriteOutcome(0, 0, []));

        $committer = new ConfirmCommitter(
            labWriter:        $writer,
            writersByDocType: [],
            jobs:             $jobs,
            sidecar:          $sidecar,
            statusMachine:    new UploadJobStatusMachine(),
        );

        $committer->confirm(self::JOB_UUID, [], self::USER_ID);

        self::assertSame(UploadJobStatus::Committed, $captured);
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    private function jobIn(UploadJobStatus $status, string $docType): UploadJobRow
    {
        return new UploadJobRow(
            jobUuid:    self::JOB_UUID,
            documentId: self::DOC_ID,
            patientId:  self::PID,
            docType:    $docType,
            status:     $status,
        );
    }

    /**
     * @param array<string, mixed> $original
     */
    private function extractionRow(array $original): ExtractionRow
    {
        return new ExtractionRow(
            extractionId: self::EXTR_ID,
            documentId:   self::DOC_ID,
            patientId:    self::PID,
            docType:      'lab_pdf',
            originalJson: $original,
        );
    }

    private function mockJobsPersister(
        UploadJobRow $loadedJob,
        UploadJobTransition $expectTransition,
        ?string $expectedErrorMessage = null,
    ): UploadJobsPersister {
        $jobs = $this->createMock(UploadJobsPersister::class);
        $jobs->method('loadJob')->willReturn($loadedJob);
        $jobs->expects(self::once())
            ->method('applyTransition')
            ->with(
                self::JOB_UUID,
                UploadJobStatus::ReadyForReview,
                $expectTransition,
                self::isInstanceOf(UploadJobStatusMachine::class),
                $expectedErrorMessage,
            )
            ->willReturnCallback(static fn(string $u, UploadJobStatus $c, UploadJobTransition $t, UploadJobStatusMachine $m, ?string $err): UploadJobStatus => $m->next($c, $t));
        return $jobs;
    }

    private function mockSidecarPersister(
        ExtractionRow $extraction,
        string $expectStamp,
    ): SidecarPersister {
        $sidecar = $this->createMock(SidecarPersister::class);
        $sidecar->method('loadByDocumentId')->willReturn($extraction);
        $sidecar->method('stampReview');
        $sidecar->method('updateExtractedJson');
        return $sidecar;
    }

    private function makeStubLabWriter(): LabFhirWriter
    {
        $writer = $this->createMock(LabFhirWriter::class);
        $writer->method('writeThrough')->willReturn(new LabWriteOutcome(0, 0, []));
        return $writer;
    }

    private function makeRecordingWriter(WriteOutcome $outcome): RecordingDocumentWriter
    {
        return new RecordingDocumentWriter($outcome);
    }
}

/**
 * Inline test fake: counts calls and remembers args. Used in tests that
 * need to assert "the right writer was called" without the verbosity of
 * a PHPUnit invocation matcher (the intent is "this is the call site
 * record", not "verify a strict mock script").
 */
final class RecordingDocumentWriter implements DocumentWriter
{
    /** @var list<array{extractionId: int, patientId: int, documentId: int, extracted: array<string, mixed>}> */
    private array $calls = [];

    public function __construct(private readonly WriteOutcome $outcome)
    {
    }

    public function writeThrough(int $extractionId, int $patientId, int $documentId, array $extracted): WriteOutcome
    {
        $this->calls[] = [
            'extractionId' => $extractionId,
            'patientId'    => $patientId,
            'documentId'   => $documentId,
            'extracted'    => $extracted,
        ];
        return $this->outcome;
    }

    public function callCount(): int
    {
        return count($this->calls);
    }

    /**
     * @return array{extractionId: int, patientId: int, documentId: int, extracted: array<string, mixed>}
     */
    public function lastCall(): array
    {
        if ($this->calls === []) {
            throw new \LogicException('no calls recorded');
        }
        return $this->calls[count($this->calls) - 1];
    }
}
