<?php

/**
 * DeleteJobResult — typed envelope returned by
 * {@see DeleteJobController::handle()}.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\AgentForge\Controller;

final readonly class DeleteJobResult
{
    private function __construct(public DeleteJobOutcome $outcome)
    {
    }

    public static function ok(): self
    {
        return new self(DeleteJobOutcome::Ok);
    }

    public static function notFound(): self
    {
        return new self(DeleteJobOutcome::NotFound);
    }

    public static function forbidden(): self
    {
        return new self(DeleteJobOutcome::Forbidden);
    }
}
