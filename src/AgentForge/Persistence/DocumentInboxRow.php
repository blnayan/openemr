<?php

/**
 * DocumentInboxRow — read-only projection of a single upload-job row
 * surfaced to the Document Inbox history pane.
 *
 * One instance corresponds to one row in
 * {@see \OpenEMR\AgentForge\Persistence\DocumentInboxQueryService}'s
 * grouped result. The shape is exactly the on-screen data the inbox
 * table needs:
 *
 *   - `jobUuid`         — primary key for status polling, confirm,
 *                         and reject endpoints.
 *   - `documentId`      — canonical OpenEMR `documents.id`; used to
 *                         build the "View document" link that opens
 *                         the source PDF in the Documents tab (PRD
 *                         user story 21).
 *   - `extractionId`    — `agentforge_document_extractions.id` for the
 *                         "View extraction" read-only review link
 *                         (PRD user story 22). Nullable because
 *                         extraction may not have started or may have
 *                         failed before the sidecar row was inserted.
 *   - `docType`         — the form field selected at upload time (no
 *                         category-substring guesswork).
 *   - `status`          — typed UploadJobStatus; the inbox renders
 *                         it as a color-coded badge.
 *   - `provenance`      — `vlm_only` vs `human_corrected`; computed
 *                         from `edited_field_paths` (PRD user
 *                         stories 19 & 20).
 *   - `filename`        — display-only; the inbox shows it and the
 *                         "View document" link uses it as link text.
 *   - `uploadedByUserId`/ `uploadedByDisplayName` — uploader column
 *                         (PRD §History pane: "uploaded-by + relative
 *                         time"). Display name is denormalized for the
 *                         table view; the user id is the joinable
 *                         primary key.
 *   - `uploadedAt`      — DateTimeImmutable; the table sorts on this.
 *   - `errorMessage`    — surfaced on `failed` rows so the clerk can
 *                         decide whether to retry. NULL on success.
 *   - `editedFieldPaths`— the dotted-path list the reviewer changed
 *                         away from the VLM's output. NULL when the
 *                         reviewer accepted the VLM verbatim (and on
 *                         pre-review rows). Drives the
 *                         provenance-filter chip without forcing the
 *                         frontend to JSON-decode a payload.
 *
 * No PHI text from the extracted document body lives here. Filenames
 * may incidentally contain a patient's name (a clerical norm), but
 * that name appears in the canonical Documents tab too — it is not a
 * payload the inbox surfaces in addition to existing OpenEMR exposure.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\AgentForge\Persistence;

use DateTimeImmutable;
use OpenEMR\AgentForge\Domain\UploadJobProvenance;
use OpenEMR\AgentForge\Domain\UploadJobStatus;

final readonly class DocumentInboxRow
{
    /**
     * @param list<string>|null $editedFieldPaths
     */
    public function __construct(
        public string $jobUuid,
        public int $documentId,
        public ?int $extractionId,
        public string $docType,
        public UploadJobStatus $status,
        public UploadJobProvenance $provenance,
        public string $filename,
        public ?int $uploadedByUserId,
        public ?string $uploadedByDisplayName,
        public DateTimeImmutable $uploadedAt,
        public ?string $errorMessage,
        public ?array $editedFieldPaths,
    ) {
    }
}
