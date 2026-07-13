<?php

/**
 * ConfirmJobController — POST upload-job confirm.
 *
 * Accepts the reviewer's edited JSON, asserts the patient binding, and
 * delegates to {@see ConfirmCommitter}. The strict-status invariant
 * lives entirely in `ConfirmCommitter`; on a double-confirm or stale
 * tab the committer throws
 * {@see UploadJobNotReadyForReviewException}, which the HTTP entry
 * point maps to 409 Conflict per the PRD.
 *
 * Patient binding: the HTTP entry point passes the session-bound pid;
 * the controller refuses to confirm a job whose patient_id does not
 * match (forbidden), independently of the
 * `patients/docs/write` ACL gate.
 *
 * `EditedFieldPathDiffer` (issue 24) is invoked inside `ConfirmCommitter`
 * before the doc-type writer fires; this controller only ferries the
 * raw edited-JSON dictionary in.
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
use OpenEMR\AgentForge\Persistence\WriteOutcome;

final readonly class ConfirmJobController
{
    /**
     * @param Closure(string $jobUuid, array<string, mixed> $editedJson, int $userId): WriteOutcome $confirm
     *     Wraps {@see ConfirmCommitter::confirm()} so the controller is
     *     unit-testable without mocking the `final readonly` committer
     *     class. The closure may throw
     *     {@see UploadJobNotReadyForReviewException} on stale status —
     *     the HTTP entry point catches that directly so the
     *     `current_status` from the typed exception can leak into the
     *     response body.
     */
    public function __construct(
        private UploadJobsPersister $jobs,
        private Closure $confirm,
    ) {
    }

    /**
     * @param array<string, mixed> $editedJson
     */
    public function handle(string $jobUuid, array $editedJson, int $userId, int $sessionPid): ConfirmJobResult
    {
        if ($jobUuid === '' || $userId <= 0 || $sessionPid <= 0) {
            return ConfirmJobResult::notFound();
        }
        $view = $this->jobs->loadStatusView($jobUuid);
        if ($view === null) {
            return ConfirmJobResult::notFound();
        }
        if ($view->patientId !== $sessionPid) {
            return ConfirmJobResult::forbidden();
        }

        $outcome = ($this->confirm)($jobUuid, $editedJson, $userId);
        return ConfirmJobResult::ok($outcome);
    }

    /**
     * Production confirm closure: thin wrapper over
     * {@see ConfirmCommitter::confirm()} that satisfies the
     * controller's constructor type.
     *
     * @return Closure(string, array<string, mixed>, int): WriteOutcome
     */
    public static function defaultConfirm(ConfirmCommitter $committer): Closure
    {
        return static function (string $jobUuid, array $editedJson, int $userId) use ($committer): WriteOutcome {
            // Narrow to the string-keyed shape ConfirmCommitter::confirm()
            // expects. The HTTP entry point already filters for string
            // keys before calling the controller, but PHPStan cannot
            // see through Closure variance — narrow at the call site.
            $stringKeyed = [];
            foreach ($editedJson as $key => $value) {
                if (is_string($key)) {
                    $stringKeyed[$key] = $value;
                }
            }
            return $committer->confirm($jobUuid, $stringKeyed, $userId);
        };
    }
}
