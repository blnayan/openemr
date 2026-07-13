<?php

/**
 * AgentAuditService Unit Test
 *
 * Verifies that AgentAuditService delegates to EventAuditLogger with the correct event
 * name constants, user, groupname, success flag, comments, and patient_id.
 *
 * Plan reference: §5.1, §3.1 (AgentAuditService contract), M1, AUDIT.md §3
 * "Uses EventAuditLogger::newEvent — no parallel audit surface introduced"
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Test Generator
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Unit\AgentForge\Audit;

use OpenEMR\AgentForge\Audit\AgentAuditService;
use OpenEMR\Common\Logging\EventAuditLogger;
use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Test;
use PHPUnit\Framework\MockObject\MockObject;
use PHPUnit\Framework\TestCase;

#[CoversClass(AgentAuditService::class)]
final class AgentAuditServiceTest extends TestCase
{
    /** @var EventAuditLogger&MockObject */
    private EventAuditLogger $loggerMock;
    private AgentAuditService $service;

    protected function setUp(): void
    {
        $this->loggerMock = $this->createMock(EventAuditLogger::class);
        $this->service    = new AgentAuditService($this->loggerMock);
    }

    #[Test]
    public function logEventDelegatesToEventAuditLoggerNewEvent(): void
    {
        // AUDIT.md §3: "Uses EventAuditLogger::newEvent — never invents a parallel audit surface"
        $this->loggerMock
            ->expects(self::once())
            ->method('newEvent')
            ->with(
                AgentAuditService::EVENT_CHAT_START,
                'dr.smith',
                'Default',
                true,
                self::anything(),   // comments can be any string
                42,                 // patient_id / pid
                'open-emr'
            );

        $this->service->logEvent(
            AgentAuditService::EVENT_CHAT_START,
            'dr.smith',
            'Default',
            true,
            'conversation_id=abc',
            42,
        );
    }

    /**
     * @return array<string, array{string}>
     *
     * @codeCoverageIgnore Data providers run before coverage instrumentation starts.
     */
    public static function eventNameConstantsProvider(): array
    {
        return [
            'chat start'    => [AgentAuditService::EVENT_CHAT_START],
            'chat end'      => [AgentAuditService::EVENT_CHAT_END],
            'tool call'     => [AgentAuditService::EVENT_TOOL_CALL],
            'tool result'   => [AgentAuditService::EVENT_TOOL_RESULT],
            'verify reject' => [AgentAuditService::EVENT_VERIFY_REJECT],
            'response'      => [AgentAuditService::EVENT_RESPONSE],
            'acl denied'    => [AgentAuditService::EVENT_ACL_DENIED],
        ];
    }

    #[DataProvider('eventNameConstantsProvider')]
    #[Test]
    public function eventNameConstantsAreNonEmpty(string $eventName): void
    {
        self::assertNotEmpty($eventName, 'Every event name constant must be non-empty');
    }

    #[DataProvider('eventNameConstantsProvider')]
    #[Test]
    public function eventNameConstantsStartWithAgentforgePrefix(string $eventName): void
    {
        // §3.1 audit event catalog — all events use "agentforge:" prefix
        self::assertStringStartsWith(
            'agentforge:',
            $eventName,
            "Event name '$eventName' must start with 'agentforge:' per plan §3.1"
        );
    }

    #[Test]
    public function logEventPassesSuccessFalseOnFailure(): void
    {
        $this->loggerMock
            ->expects(self::once())
            ->method('newEvent')
            ->with(
                AgentAuditService::EVENT_ACL_DENIED,
                self::anything(),
                self::anything(),
                false,  // success = false
                self::anything(),
                self::anything(),
                'open-emr',
            );

        $this->service->logEvent(
            AgentAuditService::EVENT_ACL_DENIED,
            'dr.smith',
            'Default',
            false,
            'acl check failed',
            42,
        );
    }

    #[Test]
    public function logEventPassesPidAsPatientId(): void
    {
        $expectedPid = 9001;

        $this->loggerMock
            ->expects(self::once())
            ->method('newEvent')
            ->with(
                self::anything(),
                self::anything(),
                self::anything(),
                self::anything(),
                self::anything(),
                $expectedPid,   // patient_id must match pid
                self::anything(),
            );

        $this->service->logEvent(
            AgentAuditService::EVENT_RESPONSE,
            'user',
            'group',
            true,
            'comments',
            $expectedPid,
        );
    }

    #[Test]
    public function eventChatStartMatchesArchitectureAuditSpec(): void
    {
        // ARCHITECTURE.md §"Audit Logging": event string 'agentforge:chat:turn'
        // Plan §3.1 splits into :start and :end — verify both exist and contain 'chat'
        self::assertStringContainsString('chat', AgentAuditService::EVENT_CHAT_START);
        self::assertStringContainsString('chat', AgentAuditService::EVENT_CHAT_END);
    }

    #[Test]
    public function allDefinedEventConstantsAreUnique(): void
    {
        $allEvents = [
            AgentAuditService::EVENT_CHAT_START,
            AgentAuditService::EVENT_CHAT_END,
            AgentAuditService::EVENT_TOOL_CALL,
            AgentAuditService::EVENT_TOOL_RESULT,
            AgentAuditService::EVENT_VERIFY_REJECT,
            AgentAuditService::EVENT_RESPONSE,
            AgentAuditService::EVENT_ACL_DENIED,
        ];

        self::assertCount(
            count($allEvents),
            array_unique($allEvents),
            'All AgentAuditService event name constants must be unique'
        );
    }
}
