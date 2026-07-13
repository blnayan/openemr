<?php

/**
 * ScopedJwtClaims DTO Unit Test
 *
 * Verifies ScopedJwtClaims readonly enforcement and construction.
 *
 * Plan reference: §5.1, §3.1 (ScopedJwtClaims DTO), M1
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Test Generator
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Unit\AgentForge\Security;

use OpenEMR\AgentForge\Security\ScopedJwtClaims;
use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\Attributes\Test;
use PHPUnit\Framework\TestCase;

#[CoversClass(ScopedJwtClaims::class)]
final class ScopedJwtClaimsTest extends TestCase
{
    #[Test]
    public function constructorAcceptsValidValues(): void
    {
        $claims = new ScopedJwtClaims(
            userId: 'dr.smith',
            groupname: 'Default',
            role: 'physician',
            pid: 42,
            patientUuid: '8a3f1234-abcd-4def-bcde-000000000042',
            encounterId: 17,
            sessionId: 'sess-abc123',
            scope: 'agentforge:chat',
        );

        self::assertSame('dr.smith', $claims->userId);
        self::assertSame('Default',  $claims->groupname);
        self::assertSame('physician', $claims->role);
        self::assertSame(42,          $claims->pid);
        self::assertSame('8a3f1234-abcd-4def-bcde-000000000042', $claims->patientUuid);
        self::assertSame(17,          $claims->encounterId);
        self::assertSame('sess-abc123', $claims->sessionId);
        self::assertSame('agentforge:chat', $claims->scope);
    }

    #[Test]
    public function constructorAcceptsNullEncounterIdForDashboardMount(): void
    {
        // D5 (post-pivot): encounter_id is null when the chat is opened from
        // the patient dashboard between rooms — there is no encounter yet.
        $claims = new ScopedJwtClaims(
            userId: 'dr.smith',
            groupname: 'Default',
            role: 'physician',
            pid: 42,
            patientUuid: '8a3f1234-abcd-4def-bcde-000000000042',
            encounterId: null,
            sessionId: 'sess-abc123',
            scope: 'agentforge:chat',
        );

        self::assertNull($claims->encounterId);
        self::assertSame(42, $claims->pid);
        self::assertSame('8a3f1234-abcd-4def-bcde-000000000042', $claims->patientUuid);
    }

    #[Test]
    public function scopedJwtClaimsClassIsReadonly(): void
    {
        // §4.4: "readonly on DTOs and value objects"
        $reflection = new \ReflectionClass(ScopedJwtClaims::class);
        self::assertTrue(
            $reflection->isReadOnly(),
            'ScopedJwtClaims must be declared as a readonly class'
        );
    }

    #[Test]
    public function scopedJwtClaimsClassIsFinal(): void
    {
        $reflection = new \ReflectionClass(ScopedJwtClaims::class);
        self::assertTrue(
            $reflection->isFinal(),
            'ScopedJwtClaims must be final to prevent mutable subclasses'
        );
    }

    #[Test]
    public function mutatingReadonlyPropertyThrowsError(): void
    {
        // PHP enforces readonly at the engine level; this confirms the contract
        $this->expectException(\Error::class);

        $claims = new ScopedJwtClaims(
            userId: 'u',
            groupname: 'g',
            role: 'r',
            pid: 1,
            patientUuid: 'uuid',
            encounterId: 1,
            sessionId: 's',
            scope: 'agentforge:chat',
        );

        // @phpstan-ignore-next-line
        $claims->pid = 999;
    }
}
