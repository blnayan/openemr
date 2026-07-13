<?php

/**
 * Isolated ScopedJwtMinter Test
 *
 * Tests ScopedJwtMinter without database or OpenEMR bootstrap.
 * All tests are pure unit tests exercising JWT minting logic and claim validation.
 *
 * Plan reference: §5.1, §3.1 (ScopedJwtMinter contract), M1
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Test Generator
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\AgentForge\Security;

use InvalidArgumentException;
use Lcobucci\JWT\Configuration;
use Lcobucci\JWT\Signer\Hmac\Sha256;
use Lcobucci\JWT\Signer\Key\InMemory;
use OpenEMR\AgentForge\Security\ScopedJwtClaims;
use OpenEMR\AgentForge\Security\ScopedJwtMinter;
use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Test;
use PHPUnit\Framework\TestCase;
use Psr\Clock\ClockInterface;

#[CoversClass(ScopedJwtMinter::class)]
#[CoversClass(ScopedJwtClaims::class)]
final class ScopedJwtMinterIsolatedTest extends TestCase
{
    private const SIGNING_SECRET = 'this-is-a-256-bit-test-secret-for-agentforge-jwt-signing!!';

    private ClockInterface $clock;

    protected function setUp(): void
    {
        // ASSUMPTION: lcobucci/clock ^3.0 is installed (SystemClock implements Psr\Clock\ClockInterface).
        // If v2.3 is installed, this mock approach still works because we use a test double.
        // See Q-NEW-5 in §6 of IMPLEMENTATION_PLAN.md.
        $now = new \DateTimeImmutable('2026-01-01T12:00:00Z');
        $this->clock = new class ($now) implements ClockInterface {
            public function __construct(private readonly \DateTimeImmutable $now) {}
            public function now(): \DateTimeImmutable
            {
                return $this->now;
            }
        };
    }

    private function validClaims(): ScopedJwtClaims
    {
        return new ScopedJwtClaims(
            userId: 'dr.smith',
            groupname: 'Default',
            role: 'physician',
            pid: 42,
            patientUuid: '8a3f1234-abcd-4def-bcde-000000000042',
            encounterId: 17,
            sessionId: 'sess-abc123',
            scope: 'agentforge:chat',
        );
    }

    private function makeJwtConfig(): Configuration
    {
        return Configuration::forSymmetricSigner(
            new Sha256(),
            InMemory::plainText(self::SIGNING_SECRET),
        );
    }

    #[Test]
    public function happyPathMintReturnsNonEmptyString(): void
    {
        $minter = new ScopedJwtMinter(self::SIGNING_SECRET, $this->clock);
        $token  = $minter->mint($this->validClaims());

        self::assertNotEmpty($token, 'mint() must return a non-empty JWT string');
        self::assertIsString($token);
    }

    #[Test]
    public function mintedTokenCarriesRequiredClaims(): void
    {
        $minter = new ScopedJwtMinter(self::SIGNING_SECRET, $this->clock);
        $rawJwt = $minter->mint($this->validClaims());

        $config = $this->makeJwtConfig();
        $parsed = $config->parser()->parse($rawJwt);
        $claims = $parsed->claims();

        // §3.1 JWT payload — all required claims must be present
        self::assertSame(ScopedJwtMinter::ISSUER,   $claims->get('iss'), 'iss must be openemr-agentforge');
        self::assertSame(ScopedJwtMinter::AUDIENCE, $claims->get('aud')[0] ?? null, 'aud must be agentforge-service');
        self::assertSame(ScopedJwtMinter::SCOPE,    $claims->get('scope'), 'scope must be agentforge:chat');
        self::assertSame('dr.smith', $claims->get('sub'), 'sub must equal userId');
        self::assertSame(42,         $claims->get('pid'), 'pid must match ScopedJwtClaims');
        self::assertSame('8a3f1234-abcd-4def-bcde-000000000042', $claims->get('patient_uuid'));
        self::assertSame(17,         $claims->get('encounter_id'));
        self::assertSame('sess-abc123', $claims->get('session_id'));
        self::assertSame('Default',  $claims->get('groupname'));
        self::assertSame('physician', $claims->get('role'));
        self::assertNotNull($claims->get('jti'), 'jti (unique token ID) must be present');
    }

    #[Test]
    public function mintedTokenExpiresExactly120SecondsAfterIssue(): void
    {
        // D4: "120-second, single-patient, scoped JWT"
        $minter = new ScopedJwtMinter(self::SIGNING_SECRET, $this->clock);
        $rawJwt = $minter->mint($this->validClaims());

        $config  = $this->makeJwtConfig();
        $parsed  = $config->parser()->parse($rawJwt);
        $claims  = $parsed->claims();

        $iat = $claims->get('iat');
        $exp = $claims->get('exp');

        self::assertInstanceOf(\DateTimeImmutable::class, $iat);
        self::assertInstanceOf(\DateTimeImmutable::class, $exp);

        $diffSeconds = $exp->getTimestamp() - $iat->getTimestamp();
        self::assertSame(
            ScopedJwtMinter::TTL_SECONDS,
            $diffSeconds,
            'JWT TTL must be exactly ' . ScopedJwtMinter::TTL_SECONDS . ' seconds (D4)'
        );
    }

    #[Test]
    public function mintedTokenIsSignedWithHs256(): void
    {
        $minter = new ScopedJwtMinter(self::SIGNING_SECRET, $this->clock);
        $rawJwt = $minter->mint($this->validClaims());

        $config    = $this->makeJwtConfig();
        $parsed    = $config->parser()->parse($rawJwt);

        // Verify that the token validates against our HS256 secret
        $validator = $config->validator();
        // If the token was NOT signed with HS256+secret, constraint would throw
        $result = $validator->validate($parsed, new \Lcobucci\JWT\Validation\Constraint\SignedWith(
            new Sha256(),
            InMemory::plainText(self::SIGNING_SECRET),
        ));
        self::assertTrue($result, 'JWT must validate with the HS256 signing secret');
    }

    #[Test]
    public function mintWithZeroPidThrowsInvalidArgumentException(): void
    {
        // §3.1: "throws \InvalidArgumentException if pid <= 0"
        $this->expectException(InvalidArgumentException::class);
        $this->expectExceptionMessageMatches('/pid/i');

        $minter = new ScopedJwtMinter(self::SIGNING_SECRET, $this->clock);
        $minter->mint(new ScopedJwtClaims(
            userId: 'dr.smith',
            groupname: 'Default',
            role: 'physician',
            pid: 0,  // invalid
            patientUuid: 'some-uuid',
            encounterId: 17,
            sessionId: 'sess',
            scope: 'agentforge:chat',
        ));
    }

    #[Test]
    public function mintWithNegativePidThrowsInvalidArgumentException(): void
    {
        $this->expectException(InvalidArgumentException::class);

        $minter = new ScopedJwtMinter(self::SIGNING_SECRET, $this->clock);
        $minter->mint(new ScopedJwtClaims(
            userId: 'dr.smith',
            groupname: 'Default',
            role: 'physician',
            pid: -1,  // invalid
            patientUuid: 'some-uuid',
            encounterId: 17,
            sessionId: 'sess',
            scope: 'agentforge:chat',
        ));
    }

    #[Test]
    public function mintWithEmptyPatientUuidThrowsInvalidArgumentException(): void
    {
        // §3.1: "throws \InvalidArgumentException if patientUuid is empty"
        $this->expectException(InvalidArgumentException::class);
        $this->expectExceptionMessageMatches('/patientUuid|patient_uuid/i');

        $minter = new ScopedJwtMinter(self::SIGNING_SECRET, $this->clock);
        $minter->mint(new ScopedJwtClaims(
            userId: 'dr.smith',
            groupname: 'Default',
            role: 'physician',
            pid: 42,
            patientUuid: '',  // invalid
            encounterId: 17,
            sessionId: 'sess',
            scope: 'agentforge:chat',
        ));
    }

    #[Test]
    public function clockInjectionMakesExpiryDeterministic(): void
    {
        // PSR-20 ClockInterface injection: two calls at the same frozen clock time
        // must produce JWTs with identical exp values
        $minter = new ScopedJwtMinter(self::SIGNING_SECRET, $this->clock);
        $config = $this->makeJwtConfig();

        $jwt1 = $config->parser()->parse($minter->mint($this->validClaims()));
        $jwt2 = $config->parser()->parse($minter->mint($this->validClaims()));

        self::assertEquals(
            $jwt1->claims()->get('exp'),
            $jwt2->claims()->get('exp'),
            'Frozen clock must produce identical exp across multiple mint() calls'
        );
    }

    #[Test]
    public function eachMintedTokenHasUniqueJti(): void
    {
        // JTI (JWT ID) must be unique per token to prevent replay attacks
        $minter = new ScopedJwtMinter(self::SIGNING_SECRET, $this->clock);
        $config = $this->makeJwtConfig();

        $jti1 = $config->parser()->parse($minter->mint($this->validClaims()))->claims()->get('jti');
        $jti2 = $config->parser()->parse($minter->mint($this->validClaims()))->claims()->get('jti');

        self::assertNotEquals($jti1, $jti2, 'Each minted JWT must have a unique jti');
    }

    #[Test]
    public function dashboardMountMintsTokenWithNullEncounterIdClaim(): void
    {
        // D5 (post-pivot): when the chat is opened from the patient dashboard,
        // encounter_id is null. The JWT must still mint successfully and the
        // claim must be either null or absent in the parsed payload.
        $minter = new ScopedJwtMinter(self::SIGNING_SECRET, $this->clock);
        $rawJwt = $minter->mint(new ScopedJwtClaims(
            userId: 'dr.smith',
            groupname: 'Default',
            role: 'physician',
            pid: 42,
            patientUuid: '8a3f1234-abcd-4def-bcde-000000000042',
            encounterId: null,
            sessionId: 'sess-abc123',
            scope: 'agentforge:chat',
        ));

        self::assertNotEmpty($rawJwt);
        $claims = $this->makeJwtConfig()->parser()->parse($rawJwt)->claims();

        // patient identity is the load-bearing claim — must always be present
        self::assertSame(42, $claims->get('pid'));
        self::assertSame('8a3f1234-abcd-4def-bcde-000000000042', $claims->get('patient_uuid'));

        // encounter_id is contextual metadata — null is the documented value
        $encounterClaim = $claims->has('encounter_id') ? $claims->get('encounter_id') : null;
        self::assertNull(
            $encounterClaim,
            'Dashboard-minted JWT must carry encounter_id=null (or omit the claim)'
        );
    }

    /**
     * @return array<string, array{int, string}>
     *
     * @codeCoverageIgnore Data providers run before coverage instrumentation starts.
     */
    public static function invalidPidProvider(): array
    {
        return [
            'zero pid'     => [0, 'pid must be > 0'],
            'negative pid' => [-1, 'negative pid must fail'],
            'very negative' => [-9999, 'large negative pid must fail'],
        ];
    }

    #[DataProvider('invalidPidProvider')]
    #[Test]
    public function mintRejectsInvalidPidValues(int $pid, string $reason): void
    {
        $this->expectException(InvalidArgumentException::class);

        $minter = new ScopedJwtMinter(self::SIGNING_SECRET, $this->clock);
        $minter->mint(new ScopedJwtClaims(
            userId: 'u',
            groupname: 'g',
            role: 'r',
            pid: $pid,
            patientUuid: 'uuid',
            encounterId: 1,
            sessionId: 's',
            scope: 'agentforge:chat',
        ));
    }
}
