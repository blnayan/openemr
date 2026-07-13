<?php

/**
 * Isolated tests for JobStatusController.
 *
 * The controller is the boundary between the GET status HTTP entry
 * point and the upload-jobs / sidecar persisters; these tests verify
 * the contract the HTTP layer (issue 26) depends on — patient binding
 * is enforced, the sidecar JSON only ships on `ready_for_review`, and
 * unknown UUIDs land in the not-found branch. Tests run without
 * database, container, or Docker.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\AgentForge\Controller;

use OpenEMR\AgentForge\Controller\JobStatusController;
use OpenEMR\AgentForge\Controller\JobStatusOutcome;
use OpenEMR\AgentForge\Domain\UploadJobStatus;
use OpenEMR\AgentForge\Persistence\ExtractionRow;
use OpenEMR\AgentForge\Persistence\SidecarPersister;
use OpenEMR\AgentForge\Persistence\UploadJobsPersister;
use OpenEMR\AgentForge\Persistence\UploadJobStatusView;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Test;
use PHPUnit\Framework\TestCase;

final class JobStatusControllerIsolatedTest extends TestCase
{
    private const JOB_UUID = 'job-uuid-12345';
    private const PID      = 17;
    private const DOC_ID   = 909;

    #[Test]
    public function returnsOkWithStatusViewWhenSessionPidMatches(): void
    {
        $view = $this->makeView(UploadJobStatus::Pending);
        $jobs = $this->createMock(UploadJobsPersister::class);
        $jobs->method('loadStatusView')->willReturn($view);

        $sidecar = $this->createMock(SidecarPersister::class);
        $sidecar->expects(self::never())->method('loadByDocumentId');

        $controller = new JobStatusController($jobs, $sidecar);
        $result = $controller->handle(self::JOB_UUID, self::PID);

        self::assertSame(JobStatusOutcome::Ok, $result->outcome);
        self::assertSame($view, $result->view);
        self::assertNull($result->extractedJson);
    }

    #[Test]
    public function returnsExtractedJsonOnlyOnReadyForReview(): void
    {
        $view = $this->makeView(UploadJobStatus::ReadyForReview);
        $jobs = $this->createMock(UploadJobsPersister::class);
        $jobs->method('loadStatusView')->willReturn($view);

        $extraction = new ExtractionRow(
            extractionId: 42,
            documentId:   self::DOC_ID,
            patientId:    self::PID,
            docType:      'lab_pdf',
            originalJson: ['tests' => [['name' => 'glucose']]],
        );

        $sidecar = $this->createMock(SidecarPersister::class);
        $sidecar->expects(self::once())
            ->method('loadByDocumentId')
            ->with(self::DOC_ID)
            ->willReturn($extraction);

        $controller = new JobStatusController($jobs, $sidecar);
        $result = $controller->handle(self::JOB_UUID, self::PID);

        self::assertSame(JobStatusOutcome::Ok, $result->outcome);
        self::assertSame(['tests' => [['name' => 'glucose']]], $result->extractedJson);
    }

    #[Test]
    public function readyForReviewWithMissingSidecarRowReturnsNullExtractedJson(): void
    {
        $view = $this->makeView(UploadJobStatus::ReadyForReview);
        $jobs = $this->createMock(UploadJobsPersister::class);
        $jobs->method('loadStatusView')->willReturn($view);

        $sidecar = $this->createMock(SidecarPersister::class);
        $sidecar->method('loadByDocumentId')->willReturn(null);

        $controller = new JobStatusController($jobs, $sidecar);
        $result = $controller->handle(self::JOB_UUID, self::PID);

        self::assertSame(JobStatusOutcome::Ok, $result->outcome);
        self::assertNull($result->extractedJson);
    }

    /**
     * @return iterable<string, array{UploadJobStatus}>
     *
     * @codeCoverageIgnore Data providers run before coverage instrumentation starts.
     */
    public static function nonReviewStatusProvider(): iterable
    {
        yield 'pending'    => [UploadJobStatus::Pending];
        yield 'extracting' => [UploadJobStatus::Extracting];
        yield 'committed'  => [UploadJobStatus::Committed];
        yield 'rejected'   => [UploadJobStatus::Rejected];
        yield 'failed'     => [UploadJobStatus::Failed];
    }

    #[Test]
    #[DataProvider('nonReviewStatusProvider')]
    public function noExtractedJsonOnNonReviewStatuses(UploadJobStatus $status): void
    {
        $view = $this->makeView($status);
        $jobs = $this->createMock(UploadJobsPersister::class);
        $jobs->method('loadStatusView')->willReturn($view);

        $sidecar = $this->createMock(SidecarPersister::class);
        $sidecar->expects(self::never())->method('loadByDocumentId');

        $controller = new JobStatusController($jobs, $sidecar);
        $result = $controller->handle(self::JOB_UUID, self::PID);

        self::assertSame(JobStatusOutcome::Ok, $result->outcome);
        self::assertNull($result->extractedJson);
    }

    #[Test]
    public function returnsNotFoundWhenJobIsMissing(): void
    {
        $jobs = $this->createMock(UploadJobsPersister::class);
        $jobs->method('loadStatusView')->willReturn(null);

        $controller = new JobStatusController($jobs, $this->createMock(SidecarPersister::class));
        $result = $controller->handle(self::JOB_UUID, self::PID);

        self::assertSame(JobStatusOutcome::NotFound, $result->outcome);
    }

    #[Test]
    public function returnsNotFoundOnEmptyJobUuid(): void
    {
        $jobs = $this->createMock(UploadJobsPersister::class);
        $jobs->expects(self::never())->method('loadStatusView');

        $controller = new JobStatusController($jobs, $this->createMock(SidecarPersister::class));
        $result = $controller->handle('', self::PID);

        self::assertSame(JobStatusOutcome::NotFound, $result->outcome);
    }

    #[Test]
    public function returnsForbiddenWhenSessionPidDoesNotMatchJobPid(): void
    {
        $view = new UploadJobStatusView(
            jobUuid:      self::JOB_UUID,
            documentId:   self::DOC_ID,
            patientId:    99,
            docType:      'lab_pdf',
            status:       UploadJobStatus::ReadyForReview,
            errorCode:    null,
            errorMessage: null,
            createdAt:    null,
            updatedAt:    null,
        );
        $jobs = $this->createMock(UploadJobsPersister::class);
        $jobs->method('loadStatusView')->willReturn($view);

        $sidecar = $this->createMock(SidecarPersister::class);
        $sidecar->expects(self::never())->method('loadByDocumentId');

        $controller = new JobStatusController($jobs, $sidecar);
        $result = $controller->handle(self::JOB_UUID, self::PID);

        self::assertSame(JobStatusOutcome::Forbidden, $result->outcome);
    }

    private function makeView(UploadJobStatus $status): UploadJobStatusView
    {
        return new UploadJobStatusView(
            jobUuid:      self::JOB_UUID,
            documentId:   self::DOC_ID,
            patientId:    self::PID,
            docType:      'lab_pdf',
            status:       $status,
            errorCode:    null,
            errorMessage: null,
            createdAt:    '2026-05-06 12:34:56',
            updatedAt:    '2026-05-06 12:34:56',
        );
    }
}
