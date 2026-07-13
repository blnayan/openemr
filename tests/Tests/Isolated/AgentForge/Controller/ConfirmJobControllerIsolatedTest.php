<?php

/**
 * Isolated tests for ConfirmJobController.
 *
 * Covers the five scenarios the issue 26 acceptance criteria call out:
 *   1. happy-path confirm flow
 *   2. double-confirm 409 (the exception passes through; the HTTP layer
 *      maps it to 409)
 *   3. reject-then-confirm 409 (same surface — terminal status raises
 *      the same typed exception)
 *   4. confirm of a non-existent job → not-found outcome
 *   5. cross-patient confirm → forbidden outcome
 *
 * Tests run without database, container, or Docker. The committer
 * dependency is injected as a closure (mirrors UploadController's
 * `extractionDispatch` pattern) so the `final readonly`
 * ConfirmCommitter need not be doubled.
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
use OpenEMR\AgentForge\Controller\ConfirmJobController;
use OpenEMR\AgentForge\Controller\ConfirmJobOutcome;
use OpenEMR\AgentForge\Domain\UploadJobStatus;
use OpenEMR\AgentForge\Exception\UploadJobNotReadyForReviewException;
use OpenEMR\AgentForge\Persistence\LabWriteOutcome;
use OpenEMR\AgentForge\Persistence\UploadJobsPersister;
use OpenEMR\AgentForge\Persistence\UploadJobStatusView;
use OpenEMR\AgentForge\Persistence\WriteOutcome;
use PHPUnit\Framework\Attributes\Test;
use PHPUnit\Framework\TestCase;

final class ConfirmJobControllerIsolatedTest extends TestCase
{
    private const JOB_UUID = 'job-uuid-confirm-1';
    private const PID      = 17;
    private const USER_ID  = 5;

    #[Test]
    public function happyPathDelegatesToCommitterAndReturnsWriteOutcome(): void
    {
        $jobs = $this->createMock(UploadJobsPersister::class);
        $jobs->method('loadStatusView')->willReturn($this->makeView(self::PID));

        $captured = [];
        $confirm = static function (string $uuid, array $edited, int $uid) use (&$captured): WriteOutcome {
            $captured[] = compact('uuid', 'edited', 'uid');
            return new LabWriteOutcome(3, 0, []);
        };

        $controller = new ConfirmJobController($jobs, $confirm);
        $result = $controller->handle(self::JOB_UUID, ['header' => ['x' => 1]], self::USER_ID, self::PID);

        self::assertSame(ConfirmJobOutcome::Ok, $result->outcome);
        self::assertNotNull($result->writeOutcome);
        self::assertSame(3, $result->writeOutcome->totalRows());
        self::assertTrue($result->writeOutcome->isClean());
        self::assertCount(1, $captured);
        self::assertSame(self::JOB_UUID, $captured[0]['uuid']);
        self::assertSame(['header' => ['x' => 1]], $captured[0]['edited']);
        self::assertSame(self::USER_ID, $captured[0]['uid']);
    }

    #[Test]
    public function doubleConfirmThrowsTypedExceptionForHttpToMapToConflict(): void
    {
        $jobs = $this->createMock(UploadJobsPersister::class);
        $jobs->method('loadStatusView')->willReturn($this->makeView(self::PID));

        $confirm = static function (): WriteOutcome {
            throw new UploadJobNotReadyForReviewException(self::JOB_UUID, UploadJobStatus::Committed);
        };

        $controller = new ConfirmJobController($jobs, $confirm);

        try {
            $controller->handle(self::JOB_UUID, [], self::USER_ID, self::PID);
            self::fail('expected UploadJobNotReadyForReviewException');
        } catch (UploadJobNotReadyForReviewException $e) {
            self::assertSame(self::JOB_UUID, $e->jobUuid);
            self::assertSame(UploadJobStatus::Committed, $e->currentStatus);
        }
    }

    #[Test]
    public function rejectThenConfirmRaisesSameTypedExceptionWithRejectedStatus(): void
    {
        $jobs = $this->createMock(UploadJobsPersister::class);
        $jobs->method('loadStatusView')->willReturn($this->makeView(self::PID));

        $confirm = static function (): WriteOutcome {
            throw new UploadJobNotReadyForReviewException(self::JOB_UUID, UploadJobStatus::Rejected);
        };

        $controller = new ConfirmJobController($jobs, $confirm);

        try {
            $controller->handle(self::JOB_UUID, [], self::USER_ID, self::PID);
            self::fail('expected UploadJobNotReadyForReviewException');
        } catch (UploadJobNotReadyForReviewException $e) {
            self::assertSame(UploadJobStatus::Rejected, $e->currentStatus);
        }
    }

    #[Test]
    public function returnsNotFoundWhenJobUuidDoesNotExist(): void
    {
        $jobs = $this->createMock(UploadJobsPersister::class);
        $jobs->method('loadStatusView')->willReturn(null);

        $calls = 0;
        $confirm = static function () use (&$calls): WriteOutcome {
            $calls++;
            return new LabWriteOutcome(0, 0, []);
        };

        $controller = new ConfirmJobController($jobs, $confirm);
        $result = $controller->handle(self::JOB_UUID, ['x' => 1], self::USER_ID, self::PID);

        self::assertSame(ConfirmJobOutcome::NotFound, $result->outcome);
        self::assertSame(0, $calls);
    }

    #[Test]
    public function crossPatientConfirmIsForbiddenAndDoesNotInvokeCommitter(): void
    {
        $jobs = $this->createMock(UploadJobsPersister::class);
        $jobs->method('loadStatusView')->willReturn($this->makeView(otherPid: 99));

        $calls = 0;
        $confirm = static function () use (&$calls): WriteOutcome {
            $calls++;
            return new LabWriteOutcome(0, 0, []);
        };

        $controller = new ConfirmJobController($jobs, $confirm);
        $result = $controller->handle(self::JOB_UUID, [], self::USER_ID, self::PID);

        self::assertSame(ConfirmJobOutcome::Forbidden, $result->outcome);
        self::assertSame(0, $calls);
    }

    #[Test]
    public function rejectsZeroOrNegativeIds(): void
    {
        $jobs = $this->createMock(UploadJobsPersister::class);
        $jobs->expects(self::never())->method('loadStatusView');

        $calls = 0;
        $confirm = $this->countingConfirm($calls);

        $controller = new ConfirmJobController($jobs, $confirm);

        $result = $controller->handle(self::JOB_UUID, [], 0, self::PID);
        self::assertSame(ConfirmJobOutcome::NotFound, $result->outcome);

        $result = $controller->handle(self::JOB_UUID, [], self::USER_ID, 0);
        self::assertSame(ConfirmJobOutcome::NotFound, $result->outcome);

        $result = $controller->handle('', [], self::USER_ID, self::PID);
        self::assertSame(ConfirmJobOutcome::NotFound, $result->outcome);

        self::assertSame(0, $calls);
    }

    private function countingConfirm(int &$calls): Closure
    {
        return static function () use (&$calls): WriteOutcome {
            $calls++;
            return new LabWriteOutcome(0, 0, []);
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
