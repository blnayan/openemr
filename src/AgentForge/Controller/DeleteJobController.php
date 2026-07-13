<?php

/**
 * DeleteJobController — POST destructive-delete of an upload job at any
 * status.
 *
 * Removes the inbox row, sidecar, resource-link cascade, AND the
 * underlying OpenEMR `documents` row + the file on disk so the
 * deleted document also disappears from the canonical Documents tab.
 * The patient-binding gate is the only safety check — any status is
 * deletable. For `committed` jobs the FHIR / `lists` write-throughs
 * are NOT unwound here; the user is responsible for cleaning those
 * up via the canonical OpenEMR surfaces. For in-flight (`pending` /
 * `extracting`) jobs the dispatcher may still be writing; deletion is
 * still allowed but the user is taking on that race.
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
use OpenEMR\AgentForge\Persistence\InboxRowDeleter;
use OpenEMR\AgentForge\Persistence\UploadJobsPersister;

final readonly class DeleteJobController
{
    /**
     * @param Closure(string $jobUuid): void $delete
     *     Wraps {@see InboxRowDeleter::deleteByJobUuid()} so the
     *     controller is unit-testable without a database.
     */
    public function __construct(
        private UploadJobsPersister $jobs,
        private Closure $delete,
    ) {
    }

    public function handle(string $jobUuid, int $sessionPid): DeleteJobResult
    {
        if ($jobUuid === '' || $sessionPid <= 0) {
            return DeleteJobResult::notFound();
        }
        $view = $this->jobs->loadStatusView($jobUuid);
        if ($view === null) {
            return DeleteJobResult::notFound();
        }
        if ($view->patientId !== $sessionPid) {
            return DeleteJobResult::forbidden();
        }

        ($this->delete)($jobUuid);
        return DeleteJobResult::ok();
    }

    /**
     * @return Closure(string): void
     */
    public static function defaultDelete(InboxRowDeleter $deleter): Closure
    {
        return static function (string $jobUuid) use ($deleter): void {
            $deleter->deleteByJobUuid($jobUuid);
        };
    }
}
