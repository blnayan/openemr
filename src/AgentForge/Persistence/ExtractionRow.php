<?php

/**
 * ExtractionRow — read-only projection of a single
 * `agentforge_document_extractions` row, narrowed to the fields
 * ConfirmCommitter needs after extraction has produced a
 * ready-for-review sidecar.
 *
 * Returned by {@see SidecarPersister::loadByDocumentId()}; the
 * originalJson field is the decoded extracted_json the VLM produced,
 * used as the left-hand side of EditedFieldPathDiffer.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\AgentForge\Persistence;

final readonly class ExtractionRow
{
    /**
     * @param array<string, mixed> $originalJson
     */
    public function __construct(
        public int $extractionId,
        public int $documentId,
        public int $patientId,
        public string $docType,
        public array $originalJson,
    ) {
    }
}
