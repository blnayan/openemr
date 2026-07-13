<?php

/**
 * ScopedJwtClaims — readonly DTO carrying every claim minted into the
 * AgentForge per-turn JWT.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\AgentForge\Security;

final readonly class ScopedJwtClaims
{
    public function __construct(
        public string $userId,
        public string $groupname,
        public string $role,
        public int $pid,
        public string $patientUuid,
        public ?int $encounterId,
        public string $sessionId,
        public string $scope,
    ) {
    }
}
