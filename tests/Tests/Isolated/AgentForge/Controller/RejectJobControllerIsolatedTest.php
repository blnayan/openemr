<?php

/**
 * Isolated tests for RejectJobController.
 *
 * Mirrors the ConfirmJobController test shape: happy-path ack,
 * stale-status raises the typed exception (HTTP layer maps it to 409),
 * unknown UUID is not-found, cross-patient is forbidden, and the
 * controller never invokes the committer when input is invalid.
 *
 * Tests run without database, container, or Docker. The committer is
 * injected as a closure to avoid doubling the `final readonly`
 * ConfirmCommitter class.
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
use OpenEMR\AgentForge\Controller\RejectJobController;
use OpenEMR\AgentForge\Controller\RejectJobOutcome;
use OpenEMR\AgentForge\Domain\UploadJobStatus;
use OpenEMR\AgentForge\Exception\UploadJobNotReadyForReviewException;
use OpenEMR\AgentForge\Persistence\UploadJobsPersister;
use OpenEMR\AgentForge\Persistence\UploadJobStatusView;
use PHPUnit\Framework\Attributes\Test;
use PHPUnit\Framework\TestCase;

final class RejectJobControllerIsolatedTest extends TestCase
{
    private const JOB_UUID = 'job-uuid-reject-1';
    private const PID      = 17;
    private const USER_ID  = 5;

    #[Test]
    public function happyPathDelegatesToCommitterAndReturnsOk(): void
    {
        $jobs = $this->createMock(UploadJobsPersister::class);
        $jobs->method('loadStatusView')->willReturn($this->makeView(self::PID));

        $captured = [];
        $reject = static function (string $uuid, int $uid) use (&$captured): void {
            $captured[] = compact('uuid', 'uid');
        };

        $controller = new RejectJobController($jobs, $reject);
        $result = $controller->handle(self::JOB_UUID, self::USER_ID, self::PID);

        self::assertSame(RejectJobOutcome::Ok, $result->outcome);
        self::assertCount(1, $captured);
        self::assertSame(self::JOB_UUID, $captured[0]['uuid']);
        self::assertSame(self::USER_ID, $captured[0]['uid']);
    }

    #[Test]
    public function rejectOfTerminalJobThrowsTypedExceptionForHttpToMapToConflict(): void
    {
        $jobs = $this->createMock(UploadJobsPersister::class);
        $jobs->method('loadStatusView')->willReturn($this->makeView(self::PID));

        $reject = static function (): void {
            throw new UploadJobNotReadyForReviewException(self::JOB_UUID, UploadJobStatus::Committed);
        };

        $controller = new RejectJobController($jobs, $reject);

        try {
            $controller->handle(self::JOB_UUID, self::USER_ID, self::PID);
            self::fail('expected UploadJobNotReadyForReviewException');
        } catch (UploadJobNotReadyForReviewException $e) {
            self::assertSame(UploadJobStatus::Committed, $e->currentStatus);
        }
    }

    #[Test]
    public function rejectOfNonExistentJobReturnsNotFound(): void
    {
        $jobs = $this->createMock(UploadJobsPersister::class);
        $jobs->method('loadStatusView')->willReturn(null);

        $calls = 0;
        $reject = $this->countingReject($calls);

        $controller = new RejectJobController($jobs, $reject);
        $result = $controller->handle(self::JOB_UUID, self::USER_ID, self::PID);

        self::assertSame(RejectJobOutcome::NotFound, $result->outcome);
        self::assertSame(0, $calls);
    }

    #[Test]
    public function crossPatientRejectIsForbiddenAndDoesNotInvokeCommitter(): void
    {
        $jobs = $this->createMock(UploadJobsPersister::class);
        $jobs->method('loadStatusView')->willReturn($this->makeView(otherPid: 99));

        $calls = 0;
        $reject = $this->countingReject($calls);

        $controller = new RejectJobController($jobs, $reject);
        $result = $controller->handle(self::JOB_UUID, self::USER_ID, self::PID);

        self::assertSame(RejectJobOutcome::Forbidden, $result->outcome);
        self::assertSame(0, $calls);
    }

    #[Test]
    public function rejectsInvalidPositiveIds(): void
    {
        $jobs = $this->createMock(UploadJobsPersister::class);
        $jobs->expects(self::never())->method('loadStatusView');

        $calls = 0;
        $reject = $this->countingReject($calls);

        $controller = new RejectJobController($jobs, $reject);

        self::assertSame(RejectJobOutcome::NotFound, $controller->handle('', self::USER_ID, self::PID)->outcome);
        self::assertSame(RejectJobOutcome::NotFound, $controller->handle(self::JOB_UUID, 0, self::PID)->outcome);
        self::assertSame(RejectJobOutcome::NotFound, $controller->handle(self::JOB_UUID, self::USER_ID, 0)->outcome);
        self::assertSame(0, $calls);
    }

    private function countingReject(int &$calls): Closure
    {
        return static function () use (&$calls): void {
            $calls++;
        };
    }

    private function makeView(int $otherPid = self::PID): UploadJobStatusView
    {
        return new UploadJobStatusView(
            jobUuid:      self::JOB_UUID,
            documentId:   909,
            patientId:    $otherPid,
            docType:      'lab_pdf',
            status:       UploadJobStatus::ReadyForReview,
            errorCode:    null,
            errorMessage: null,
            createdAt:    '2026-05-06 00:00:00',
            updatedAt:    '2026-05-06 00:00:00',
        );
    }
}
