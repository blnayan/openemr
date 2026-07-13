<?php

/**
 * Isolated tests for DeleteJobController.
 *
 * The delete endpoint dropped its status guard after issue 32 — any
 * upload-job that the session pid owns is now deletable, regardless
 * of status. These tests pin that contract: the happy path invokes
 * the injected deleter exactly once for any status, the patient gate
 * still rejects cross-patient calls, and an invalid uuid / sessionPid
 * is short-circuited before the deleter or the persister are touched.
 *
 * Tests run without database, container, or Docker. The deleter is
 * injected as a closure to avoid doubling the `final readonly`
 * InboxRowDeleter class.
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
use OpenEMR\AgentForge\Controller\DeleteJobController;
use OpenEMR\AgentForge\Controller\DeleteJobOutcome;
use OpenEMR\AgentForge\Domain\UploadJobStatus;
use OpenEMR\AgentForge\Persistence\UploadJobsPersister;
use OpenEMR\AgentForge\Persistence\UploadJobStatusView;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Test;
use PHPUnit\Framework\TestCase;

final class DeleteJobControllerIsolatedTest extends TestCase
{
    private const JOB_UUID = 'job-uuid-delete-1';
    private const PID      = 17;

    #[Test]
    public function happyPathDelegatesToDeleterAndReturnsOk(): void
    {
        $jobs = $this->createMock(UploadJobsPersister::class);
        $jobs->method('loadStatusView')->willReturn($this->makeView(self::PID, UploadJobStatus::Rejected));

        $captured = [];
        $delete = static function (string $uuid) use (&$captured): void {
            $captured[] = $uuid;
        };

        $controller = new DeleteJobController($jobs, $delete);
        $result = $controller->handle(self::JOB_UUID, self::PID);

        self::assertSame(DeleteJobOutcome::Ok, $result->outcome);
        self::assertSame([self::JOB_UUID], $captured);
    }

    /**
     * Issue 32+: the destructive delete path is no longer status-gated.
     * Any status the patient gate accepts is deletable.
     */
    #[Test]
    #[DataProvider('allUploadStatuses')]
    public function deletesAtAnyStatus(UploadJobStatus $status): void
    {
        $jobs = $this->createMock(UploadJobsPersister::class);
        $jobs->method('loadStatusView')->willReturn($this->makeView(self::PID, $status));

        $calls = 0;
        $delete = $this->countingDelete($calls);

        $controller = new DeleteJobController($jobs, $delete);
        $result = $controller->handle(self::JOB_UUID, self::PID);

        self::assertSame(DeleteJobOutcome::Ok, $result->outcome);
        self::assertSame(1, $calls);
    }

    #[Test]
    public function deleteOfNonExistentJobReturnsNotFound(): void
    {
        $jobs = $this->createMock(UploadJobsPersister::class);
        $jobs->method('loadStatusView')->willReturn(null);

        $calls = 0;
        $delete = $this->countingDelete($calls);

        $controller = new DeleteJobController($jobs, $delete);
        $result = $controller->handle(self::JOB_UUID, self::PID);

        self::assertSame(DeleteJobOutcome::NotFound, $result->outcome);
        self::assertSame(0, $calls);
    }

    #[Test]
    public function crossPatientDeleteIsForbiddenAndDoesNotInvokeDeleter(): void
    {
        $jobs = $this->createMock(UploadJobsPersister::class);
        $jobs->method('loadStatusView')
            ->willReturn($this->makeView(otherPid: 99, status: UploadJobStatus::Rejected));

        $calls = 0;
        $delete = $this->countingDelete($calls);

        $controller = new DeleteJobController($jobs, $delete);
        $result = $controller->handle(self::JOB_UUID, self::PID);

        self::assertSame(DeleteJobOutcome::Forbidden, $result->outcome);
        self::assertSame(0, $calls);
    }

    #[Test]
    public function rejectsInvalidPositiveIds(): void
    {
        $jobs = $this->createMock(UploadJobsPersister::class);
        $jobs->expects(self::never())->method('loadStatusView');

        $calls = 0;
        $delete = $this->countingDelete($calls);

        $controller = new DeleteJobController($jobs, $delete);

        self::assertSame(DeleteJobOutcome::NotFound, $controller->handle('', self::PID)->outcome);
        self::assertSame(DeleteJobOutcome::NotFound, $controller->handle(self::JOB_UUID, 0)->outcome);
        self::assertSame(DeleteJobOutcome::NotFound, $controller->handle(self::JOB_UUID, -1)->outcome);
        self::assertSame(0, $calls);
    }

    /**
     * @return array<string, array{UploadJobStatus}>
     *
     * @codeCoverageIgnore Data providers run before coverage instrumentation starts.
     */
    public static function allUploadStatuses(): array
    {
        return [
            'pending'           => [UploadJobStatus::Pending],
            'extracting'        => [UploadJobStatus::Extracting],
            'ready_for_review'  => [UploadJobStatus::ReadyForReview],
            'committed'         => [UploadJobStatus::Committed],
            'rejected'          => [UploadJobStatus::Rejected],
            'failed'            => [UploadJobStatus::Failed],
        ];
    }

    private function countingDelete(int &$calls): Closure
    {
        return static function () use (&$calls): void {
            $calls++;
        };
    }

    private function makeView(int $otherPid = self::PID, UploadJobStatus $status = UploadJobStatus::Rejected): UploadJobStatusView
    {
        return new UploadJobStatusView(
            jobUuid:      self::JOB_UUID,
            documentId:   909,
            patientId:    $otherPid,
            docType:      'lab_pdf',
            status:       $status,
            errorCode:    null,
            errorMessage: null,
            createdAt:    '2026-05-07 00:00:00',
            updatedAt:    '2026-05-07 00:00:00',
        );
    }
}
