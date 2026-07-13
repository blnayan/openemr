<?php

/**
 * RejectJobResult — typed envelope returned by
 * {@see RejectJobController::handle()}.
 *
 * The 409 Conflict response on stale status is built from
 * {@see \OpenEMR\AgentForge\Exception\UploadJobNotReadyForReviewException}
 * which the committer throws directly; this envelope does not encode
 * that case.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\AgentForge\Controller;

final readonly class RejectJobResult
{
    private function __construct(public RejectJobOutcome $outcome)
    {
    }

    public static function ok(): self
    {
        return new self(RejectJobOutcome::Ok);
    }

    public static function notFound(): self
    {
        return new self(RejectJobOutcome::NotFound);
    }

    public static function forbidden(): self
    {
        return new self(RejectJobOutcome::Forbidden);
    }
}
