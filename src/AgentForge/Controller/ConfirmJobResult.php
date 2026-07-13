<?php

/**
 * ConfirmJobResult — typed envelope returned by
 * {@see ConfirmJobController::handle()} so the HTTP entry point can
 * branch on a closed set of outcomes (found / not-found / forbidden /
 * ok-with-write-outcome).
 *
 * The 409 Conflict response body is built from
 * {@see \OpenEMR\AgentForge\Exception\UploadJobNotReadyForReviewException}
 * which the committer throws directly; this envelope does not encode
 * that case so the HTTP layer can include the typed `current_status`.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\AgentForge\Controller;

use OpenEMR\AgentForge\Persistence\WriteOutcome;

final readonly class ConfirmJobResult
{
    private function __construct(
        public ConfirmJobOutcome $outcome,
        public ?WriteOutcome $writeOutcome,
    ) {
    }

    public static function ok(WriteOutcome $writeOutcome): self
    {
        return new self(ConfirmJobOutcome::Ok, $writeOutcome);
    }

    public static function notFound(): self
    {
        return new self(ConfirmJobOutcome::NotFound, null);
    }

    public static function forbidden(): self
    {
        return new self(ConfirmJobOutcome::Forbidden, null);
    }
}
