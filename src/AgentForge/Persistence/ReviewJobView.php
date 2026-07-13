<?php

/**
 * ReviewJobView — read-only projection of the data the review screen
 * needs for a single upload-job identified by its UUID.
 *
 * The review screen is the side-by-side document + extracted-fields
 * view. It needs:
 *   - `documentId`   — used to build the document-bytes URL.
 *   - `docType`      — the user-facing AgentForge doc type (`lab_pdf`,
 *                      `intake_form`); drives prompts and writers.
 *   - `mimeType`     — actual file MIME (e.g. `application/pdf`,
 *                      `image/png`). Determines whether the review
 *                      screen mounts PdfPageViewer or ImageViewer.
 *   - `status`       — so the screen can distinguish read-only
 *                      (committed / rejected) from editable
 *                      (ready_for_review).
 *   - `pageCount`    — from source_citation.page_count in the extracted
 *                      JSON; pages >= pageCount render the "not processed"
 *                      banner rather than overlays.
 *   - `extractedJson` — the full decoded extraction payload.  Labels and
 *                       bbox coords are read from this in the browser;
 *                       extracted text never lands in DOM data-* attributes
 *                       (PRD §"Cache and PHI posture").
 *
 * Returned by {@see DocumentInboxQueryService::loadForReview()}.
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

final readonly class ReviewJobView
{
    /**
     * @param array<string, mixed> $extractedJson  Decoded extracted_json payload.
     */
    public function __construct(
        public string $jobUuid,
        public int $documentId,
        public int $patientId,
        public string $docType,
        public string $mimeType,
        public UploadJobStatus $status,
        public int $pageCount,
        public array $extractedJson,
    ) {
    }
}
