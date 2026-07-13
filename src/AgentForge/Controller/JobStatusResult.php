<?php

/**
 * JobStatusResult — typed envelope returned by
 * {@see JobStatusController::handle()} so the HTTP entry point can
 * branch on a closed set of outcomes (found / not-found / forbidden)
 * without inspecting nullable fields.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\AgentForge\Controller;

use OpenEMR\AgentForge\Persistence\UploadJobStatusView;

final readonly class JobStatusResult
{
    /**
     * @param array<string, mixed>|null $extractedJson present only when
     *     the upload-job is in `ready_for_review` and the sidecar row
     *     was found. The HTTP entry point copies this verbatim into the
     *     response body so the review screen can render it.
     */
    private function __construct(
        public JobStatusOutcome $outcome,
        public ?UploadJobStatusView $view,
        public ?array $extractedJson,
    ) {
    }

    /**
     * @param array<string, mixed>|null $extractedJson
     */
    public static function ok(UploadJobStatusView $view, ?array $extractedJson): self
    {
        return new self(JobStatusOutcome::Ok, $view, $extractedJson);
    }

    public static function notFound(): self
    {
        return new self(JobStatusOutcome::NotFound, null, null);
    }

    public static function forbidden(): self
    {
        return new self(JobStatusOutcome::Forbidden, null, null);
    }
}
