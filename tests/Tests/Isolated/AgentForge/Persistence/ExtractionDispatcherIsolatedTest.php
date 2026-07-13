<?php

/**
 * Isolated tests for the post-rework ExtractionDispatcher.
 *
 * After the Document Inbox rework (issue 22) the dispatcher is
 * extract-only: it transitions Pending → Extracting before the agent
 * call, persists the sidecar on success and transitions to
 * ReadyForReview, and on failure transitions to Failed. It no longer
 * invokes any FHIR writer — that responsibility moved to
 * ConfirmCommitter, which the deferred-commit gate funnels through.
 *
 * The constructor no longer accepts a LabFhirWriter, so the
 * "no FHIR write from extraction" contract is structural; these tests
 * cover the behavioral pieces (correct status transitions, sidecar
 * persistence on success, no sidecar persistence on agent failure).
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
use OpenEMR\AgentForge\Http\ExtractionClient;
use OpenEMR\AgentForge\Http\ExtractionResponse;
use OpenEMR\AgentForge\Persistence\ExtractionDispatcher;
use OpenEMR\AgentForge\Persistence\SidecarPersister;
use OpenEMR\AgentForge\Persistence\UploadJobsPersister;
use OpenEMR\AgentForge\Security\ScopedJwtClaims;
use OpenEMR\AgentForge\Security\ScopedJwtMinter;
use PHPUnit\Framework\Attributes\Test;
use PHPUnit\Framework\TestCase;

final class ExtractionDispatcherIsolatedTest extends TestCase
{
    private const JOB_UUID = 'dispatch-job-0001';

    #[Test]
    public function constructorDoesNotAcceptALabFhirWriter(): void
    {
        // Reflection-based contract test: the constructor signature is
        // the structural defense against future code accidentally
        // re-introducing FHIR write-through into the dispatcher. If
        // someone adds a LabFhirWriter parameter back, this test fails
        // and the regression is caught at static-test time.
        $reflection = new \ReflectionClass(ExtractionDispatcher::class);
        $constructor = $reflection->getConstructor();
        self::assertNotNull($constructor);
        $paramTypes = [];
        foreach ($constructor->getParameters() as $p) {
            $type = $p->getType();
            if ($type instanceof \ReflectionNamedType) {
                $paramTypes[] = $type->getName();
            }
        }
        self::assertNotContains(
            \OpenEMR\AgentForge\Persistence\LabFhirWriter::class,
            $paramTypes,
            'ExtractionDispatcher must not accept a LabFhirWriter (issue 22).',
        );
    }

    #[Test]
    public function successPathTransitionsPendingThenExtractingThenReadyForReviewAndPersistsSidecar(): void
    {
        $extractedPayload = ['results' => [['test_name' => 'A1c']]];

        $client = $this->createMock(ExtractionClient::class);
        $client->expects(self::once())
            ->method('extract')
            ->willReturn(ExtractionResponse::success($extractedPayload, '1', 2));

        $jwt = $this->createMock(ScopedJwtMinter::class);
        $jwt->method('mint')->willReturn('signed-jwt');

        $sidecar = $this->createMock(SidecarPersister::class);
        $sidecar->expects(self::once())
            ->method('normalizePayload')
            ->with($extractedPayload)
            ->willReturn($extractedPayload);
        $sidecar->expects(self::once())
            ->method('persist')
            ->with(101, 17, 'lab_pdf', '1', $extractedPayload)
            ->willReturn(555);

        $jobs = $this->createMock(UploadJobsPersister::class);
        $captured = [];
        $jobs->expects(self::exactly(2))
            ->method('applyTransition')
            ->willReturnCallback(function (string $uuid, UploadJobStatus $current, UploadJobTransition $t, UploadJobStatusMachine $m, ?string $err = null) use (&$captured): UploadJobStatus {
                $captured[] = ['uuid' => $uuid, 'from' => $current, 'transition' => $t, 'err' => $err];
                return $m->next($current, $t);
            });

        $dispatcher = new ExtractionDispatcher(
            client:        $client,
            jwtMinter:     $jwt,
            sidecar:       $sidecar,
            jobs:          $jobs,
            statusMachine: new UploadJobStatusMachine(),
        );

        $ok = $dispatcher->dispatch(
            documentId:     101,
            patientId:      17,
            patientUuid:    'uuid-pat-17',
            docType:        'lab_pdf',
            mimeType:       'application/pdf',
            bytes:          'BYTES',
            jobUuid:        self::JOB_UUID,
            claimsTemplate: $this->makeClaims(),
        );

        self::assertTrue($ok);
        self::assertCount(2, $captured);
        self::assertSame(self::JOB_UUID, $captured[0]['uuid']);
        self::assertSame(UploadJobStatus::Pending, $captured[0]['from']);
        self::assertSame(UploadJobTransition::StartExtraction, $captured[0]['transition']);
        self::assertNull($captured[0]['err']);
        self::assertSame(UploadJobStatus::Extracting, $captured[1]['from']);
        self::assertSame(UploadJobTransition::ExtractionSucceeded, $captured[1]['transition']);
        self::assertNull($captured[1]['err']);
    }

    #[Test]
    public function failurePathTransitionsToFailedWithAgentErrorMessageAndDoesNotPersistSidecar(): void
    {
        $client = $this->createMock(ExtractionClient::class);
        $client->method('extract')->willReturn(
            ExtractionResponse::failure(503, 'agent_unreachable', 'connection refused', 1),
        );

        $jwt = $this->createMock(ScopedJwtMinter::class);
        $jwt->method('mint')->willReturn('signed-jwt');

        $sidecar = $this->createMock(SidecarPersister::class);
        $sidecar->expects(self::never())->method('persist');

        $jobs = $this->createMock(UploadJobsPersister::class);
        $captured = [];
        $jobs->expects(self::exactly(2))
            ->method('applyTransition')
            ->willReturnCallback(function (string $uuid, UploadJobStatus $current, UploadJobTransition $t, UploadJobStatusMachine $m, ?string $err = null) use (&$captured): UploadJobStatus {
                $captured[] = ['from' => $current, 'transition' => $t, 'err' => $err];
                return $m->next($current, $t);
            });

        $dispatcher = new ExtractionDispatcher(
            client:        $client,
            jwtMinter:     $jwt,
            sidecar:       $sidecar,
            jobs:          $jobs,
            statusMachine: new UploadJobStatusMachine(),
        );

        $ok = $dispatcher->dispatch(
            documentId:     101,
            patientId:      17,
            patientUuid:    'uuid-pat-17',
            docType:        'lab_pdf',
            mimeType:       'application/pdf',
            bytes:          'BYTES',
            jobUuid:        self::JOB_UUID,
            claimsTemplate: $this->makeClaims(),
        );

        self::assertFalse($ok);
        self::assertSame(UploadJobStatus::Pending, $captured[0]['from']);
        self::assertSame(UploadJobTransition::StartExtraction, $captured[0]['transition']);
        self::assertSame(UploadJobStatus::Extracting, $captured[1]['from']);
        self::assertSame(UploadJobTransition::Fail, $captured[1]['transition']);
        self::assertNotNull($captured[1]['err']);
        self::assertStringContainsString('agent_unreachable', $captured[1]['err']);
        self::assertStringContainsString('503', $captured[1]['err']);
    }

    private function makeClaims(): ScopedJwtClaims
    {
        return new ScopedJwtClaims(
            userId:      'admin',
            groupname:   'Default',
            role:        '',
            pid:         17,
            patientUuid: 'uuid-pat-17',
            encounterId: null,
            sessionId:   'sess-1',
            scope:       ScopedJwtMinter::SCOPE,
        );
    }
}
