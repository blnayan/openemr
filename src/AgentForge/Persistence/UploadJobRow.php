<?php

/**
 * UploadJobRow — read-only projection of a single
 * `agentforge_upload_jobs` row, narrowed to the fields ConfirmCommitter
 * and the inbox query layer need.
 *
 * Returned by {@see UploadJobsPersister::loadJob()}; consumed by
 * {@see ConfirmCommitter} to resolve doc-type routing, identify the
 * sidecar to stamp with reviewer provenance, and enforce the
 * strict-status invariant before any FHIR or `lists` write occurs.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\AgentForge\Persistence;

use OpenEMR\AgentForge\Domain\UploadJobStatus;

final readonly class UploadJobRow
{
    public function __construct(
        public string $jobUuid,
        public int $documentId,
        public int $patientId,
        public string $docType,
        public UploadJobStatus $status,
    ) {
    }
}
