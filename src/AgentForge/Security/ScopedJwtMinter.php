<?php

/**
 * ScopedJwtMinter — mints the 120-second HS256 JWT that scopes one chat
 * turn to one patient. The signed token is forwarded to the Node agent
 * sidecar where every FHIR call uses the same JWT as a Bearer token.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\AgentForge\Security;

use DateTimeImmutable;
use InvalidArgumentException;
use Lcobucci\JWT\Configuration;
use Lcobucci\JWT\Signer\Hmac\Sha256;
use Lcobucci\JWT\Signer\Key\InMemory;
use Psr\Clock\ClockInterface;
use Ramsey\Uuid\Uuid;

readonly class ScopedJwtMinter
{
    public const TTL_SECONDS = 120;
    public const ISSUER = 'openemr-agentforge';
    public const AUDIENCE = 'agentforge-service';
    public const SCOPE = 'agentforge:chat';

    public function __construct(
        private string $signingSecret,
        private ClockInterface $clock,
    ) {
    }

    /**
     * @throws InvalidArgumentException when pid <= 0 or patientUuid is empty
     */
    public function mint(ScopedJwtClaims $claims): string
    {
        if ($claims->pid <= 0) {
            throw new InvalidArgumentException('pid must be > 0');
        }
        if ($claims->patientUuid === '') {
            throw new InvalidArgumentException('patientUuid must be non-empty');
        }

        $config = Configuration::forSymmetricSigner(
            new Sha256(),
            InMemory::plainText($this->signingSecret),
        );

        $now = $this->clock->now();
        $exp = $now->modify('+' . self::TTL_SECONDS . ' seconds');

        $builder = $config->builder()
            ->issuedBy(self::ISSUER)
            ->permittedFor(self::AUDIENCE)
            ->relatedTo($claims->userId)
            ->issuedAt($now)
            // sidecar.php's StrictValidAt requires `nbf`; setting it
            // a few seconds in the past avoids validator clock skew.
            ->canOnlyBeUsedAfter($now->modify('-5 seconds'))
            ->expiresAt($exp)
            ->identifiedBy(Uuid::uuid4()->toString())
            ->withClaim('pid', $claims->pid)
            ->withClaim('patient_uuid', $claims->patientUuid)
            ->withClaim('session_id', $claims->sessionId)
            ->withClaim('groupname', $claims->groupname)
            ->withClaim('role', $claims->role)
            ->withClaim('scope', $claims->scope);

        if ($claims->encounterId !== null) {
            $builder = $builder->withClaim('encounter_id', $claims->encounterId);
        }

        return $builder->getToken($config->signer(), $config->signingKey())->toString();
    }
}
