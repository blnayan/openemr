<?php

/**
 * ChatController Unit Test
 *
 * Tests the ACL gate, audit event emission, JWT minting preconditions, and 403 behavior.
 * Uses PSR-7 mocks; does not require a running database or OpenEMR bootstrap.
 *
 * Plan reference: §5.1, §3.1 (ChatController contract), M1, ARCHITECTURE.md §"Trust Boundaries"
 * AUDIT.md §1 "FHIR ACL is role-level, not patient-level — JWT patient-scope is load-bearing"
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Test Generator
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Unit\AgentForge\Controller;

use OpenEMR\AgentForge\Audit\AgentAuditService;
use OpenEMR\AgentForge\Controller\ChatController;
use OpenEMR\AgentForge\Exception\AclDeniedException;
use OpenEMR\AgentForge\Http\SseProxyHandler;
use OpenEMR\AgentForge\Security\ScopedJwtMinter;
use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\Attributes\Test;
use PHPUnit\Framework\MockObject\MockObject;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ServerRequestInterface;

#[CoversClass(ChatController::class)]
final class ChatControllerTest extends TestCase
{
    /** @var ScopedJwtMinter&MockObject */
    private ScopedJwtMinter $jwtMinter;
    /** @var SseProxyHandler&MockObject */
    private SseProxyHandler $sseProxy;
    /** @var AgentAuditService&MockObject */
    private AgentAuditService $audit;
    private ChatController $controller;

    protected function setUp(): void
    {
        $this->jwtMinter  = $this->createMock(ScopedJwtMinter::class);
        $this->sseProxy   = $this->createMock(SseProxyHandler::class);
        $this->audit      = $this->createMock(AgentAuditService::class);
        $this->controller = new ChatController(
            $this->jwtMinter,
            $this->sseProxy,
            $this->audit,
        );
    }

    #[Test]
    public function handleThrowsAclDeniedExceptionWhenAclCheckFails(): void
    {
        // §3.1: "throws AclDeniedException if ACL check fails — caller renders 403"
        // B1 (ARCHITECTURE.md §"Trust Boundaries"): "ACL enforced by AclMain::aclCheckCore at the edge"
        $this->expectException(AclDeniedException::class);

        // ASSUMPTION: ChatController internally calls AclMain::aclCheckCore('patients', 'read').
        // When the session does not have the required permission, it throws AclDeniedException.
        // We simulate this by passing a request that triggers the no-session code path.
        $request = $this->createMock(ServerRequestInterface::class);
        $request->method('getParsedBody')->willReturn([
            'question'        => 'What are her labs?',
            'conversation_id' => null,
            'encounter_id'    => 17,
        ]);
        // No session attributes — should fail ACL
        $request->method('getAttribute')->willReturn(null);

        $this->controller->handle($request);
    }

    #[Test]
    public function handleDoesNotMintJwtWhenAclFails(): void
    {
        // §3.1: "ACL check fires before any JWT is minted"
        // D5: per-patient JWT is the load-bearing security primitive
        $this->jwtMinter
            ->expects(self::never())
            ->method('mint');

        $request = $this->buildUnauthenticatedRequest();

        try {
            $this->controller->handle($request);
        } catch (AclDeniedException) {
            // Expected — JWT must NOT have been minted
        }
    }

    #[Test]
    public function handleEmitsAuditEventOnChatTurnStart(): void
    {
        // §3.1: "Audit log on entry: agentforge:chat:turn:start"
        $this->audit
            ->expects(self::atLeastOnce())
            ->method('logEvent')
            ->with(
                AgentAuditService::EVENT_CHAT_START,
                self::anything(),
                self::anything(),
                self::anything(),
                self::anything(),
                self::anything(),
            );

        // ASSUMPTION: This test requires a valid-session request path.
        // The test will fail until ChatController is implemented. That is the intended red-phase state.
        $request = $this->buildAuthenticatedRequest();
        $this->controller->handle($request);
    }

    #[Test]
    public function handleAcceptsRequestWithoutEncounterIdFromDashboardMount(): void
    {
        // D5 (post-pivot): the agent mounts on the patient dashboard between
        // rooms — there is no active encounter. The controller must accept a
        // request body where encounter_id is null or missing and still mint
        // a JWT scoped to the patient.
        $request = $this->createMock(ServerRequestInterface::class);
        $request->method('getParsedBody')->willReturn([
            'question'        => 'What changed since her last visit?',
            'conversation_id' => null,
            // encounter_id intentionally omitted (dashboard mount)
        ]);
        $request->method('getAttribute')->willReturnMap([
            ['auth_user',     null, 'dr.smith'],
            ['auth_provider', null, 'Default'],
            ['auth_role',     null, 'physician'],
            ['pid',           null, 42],
            ['patient_uuid',  null, '8a3f1234-abcd-4def-bcde-000000000042'],
            ['session_id',    null, 'sess-abc123'],
        ]);

        // Should not throw — encounter_id is contextual metadata, not load-bearing.
        try {
            $this->controller->handle($request);
        } catch (\InvalidArgumentException $e) {
            self::fail(
                'Controller must accept dashboard-mount requests with no encounter_id; got: '
                . $e->getMessage()
            );
        } catch (\Throwable) {
            // Other exceptions (e.g. the SSE proxy mock not being primed) are
            // fine for this test — we only care that the missing encounter_id
            // does not itself cause rejection.
        }
    }

    #[Test]
    public function aclDeniedExceptionExtendsCorrectBaseClass(): void
    {
        // §4.4: "AclDeniedException extends \DomainException (not \RuntimeException)"
        $exception = new AclDeniedException('test');
        self::assertInstanceOf(
            \DomainException::class,
            $exception,
            'AclDeniedException must extend \DomainException per §4.4'
        );
    }

    private function buildUnauthenticatedRequest(): ServerRequestInterface
    {
        $request = $this->createMock(ServerRequestInterface::class);
        $request->method('getParsedBody')->willReturn([]);
        $request->method('getAttribute')->willReturn(null);
        return $request;
    }

    private function buildAuthenticatedRequest(): ServerRequestInterface
    {
        // ASSUMPTION: Authenticated requests carry session claims as request attributes.
        // The exact mechanism depends on how the entry-point file populates PSR-7 attributes.
        $request = $this->createMock(ServerRequestInterface::class);
        $request->method('getParsedBody')->willReturn([
            'question'        => 'What are her labs?',
            'conversation_id' => null,
            'encounter_id'    => 17,
        ]);
        $request->method('getAttribute')->willReturnMap([
            ['auth_user',     null, 'dr.smith'],
            ['auth_provider', null, 'Default'],
            ['auth_role',     null, 'physician'],
            ['pid',           null, 42],
            ['patient_uuid',  null, '8a3f1234-abcd-4def-bcde-000000000042'],
            ['session_id',    null, 'sess-abc123'],
        ]);
        return $request;
    }
}
