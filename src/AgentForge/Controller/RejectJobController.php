<?php

/**
 * RejectJobController — POST upload-job whole-document reject.
 *
 * Asserts the patient binding and delegates to
 * {@see ConfirmCommitter::reject()}. No FHIR / `lists` writes occur on
 * this path; the committer transitions the upload-job to the
 * `rejected` terminal state and stamps the sidecar with the reviewer's
 * provenance.
 *
 * Like {@see ConfirmJobController}, the strict-status invariant lives
 * inside `ConfirmCommitter`. A reject of a job that is already
 * `committed` / `rejected` / `failed` raises
 * {@see UploadJobNotReadyForReviewException} which the HTTP entry
 * point maps to 409 Conflict.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\AgentForge\Controller;

use Closure;
use OpenEMR\AgentForge\Persistence\ConfirmCommitter;
use OpenEMR\AgentForge\Persistence\UploadJobsPersister;

final readonly class RejectJobController
{
    /**
     * @param Closure(string $jobUuid, int $userId): void $reject
     *     Wraps {@see ConfirmCommitter::reject()} so the controller is
     *     unit-testable without mocking the `final readonly` committer
     *     class. The closure may throw
     *     {@see UploadJobNotReadyForReviewException} on stale status —
     *     the HTTP entry point catches that directly.
     */
    public function __construct(
        private UploadJobsPersister $jobs,
        private Closure $reject,
    ) {
    }

    public function handle(string $jobUuid, int $userId, int $sessionPid): RejectJobResult
    {
        if ($jobUuid === '' || $userId <= 0 || $sessionPid <= 0) {
            return RejectJobResult::notFound();
        }
        $view = $this->jobs->loadStatusView($jobUuid);
        if ($view === null) {
            return RejectJobResult::notFound();
        }
        if ($view->patientId !== $sessionPid) {
            return RejectJobResult::forbidden();
        }

        ($this->reject)($jobUuid, $userId);
        return RejectJobResult::ok();
    }

    /**
     * Production reject closure: thin wrapper over
     * {@see ConfirmCommitter::reject()} that satisfies the
     * controller's constructor type.
     *
     * @return Closure(string, int): void
     */
    public static function defaultReject(ConfirmCommitter $committer): Closure
    {
        return static function (string $jobUuid, int $userId) use ($committer): void {
            $committer->reject($jobUuid, $userId);
        };
    }
}
