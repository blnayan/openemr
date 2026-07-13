<?php

/**
 * DocumentInboxQueryService — read-only projection that powers the
 * Document Inbox tab (PRD §History pane).
 *
 * Given a patient id and a typed options bag, returns a
 * {@see DocumentInboxResult} grouping the patient's upload-jobs into
 * an `active` list (pending / extracting / ready_for_review) and a
 * `history` list (committed / rejected / failed). Each row carries
 * the metadata the table renders: filename, doc_type, uploader,
 * uploaded-at, status, optional error message, the document_id (so
 * the canonical Documents-tab "View document" link can be built), the
 * extraction_id (so the read-only review link can be built), and a
 * derived `provenance` flag — `human_corrected` when
 * `edited_field_paths` is non-empty, `vlm_only` otherwise.
 *
 * The service touches only the database and emits no logs. Filenames
 * and uploader names are display strings the inbox already shows; no
 * extracted document text or bounding-box payload is materialised
 * here. PHI redaction is preserved by virtue of not loading those
 * payloads at all.
 *
 * Filters (issue 27 acceptance):
 *   - `status=...`        narrows to a single UploadJobStatus.
 *   - `provenance=...`    narrows to one provenance bucket; computed
 *                         from `edited_field_paths` IS NOT NULL AND
 *                         JSON_LENGTH(edited_field_paths) > 0.
 *
 * Pagination is offset-based; default sort is uploaded-at descending;
 * default page size is 25.
 *
 * Tests inject a {@see RowFetcher} closure to keep the service free of
 * a database dependency. Production wiring uses the static
 * QueryUtils-backed factory {@see self::default()}.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\AgentForge\Persistence;

use Closure;
use DateTimeImmutable;
use DateTimeZone;
use OpenEMR\AgentForge\Domain\UploadJobProvenance;
use OpenEMR\AgentForge\Domain\UploadJobStatus;
use OpenEMR\Common\Database\QueryUtils;

/**
 * @phpstan-type RawRow array<string, mixed>
 *
 * The fetcher receives a parameterised SQL string and a positional
 * binds list and returns the matching rows. Production passes
 * {@see QueryUtils::fetchRecords()}; tests pass a recording closure.
 *
 * @phpstan-type RowFetcher Closure(string, list<scalar|null>): list<RawRow>
 */
final readonly class DocumentInboxQueryService
{
    /**
     * Statuses surfaced in the `active` group (the PRD's "in-progress
     * uploads above the history list" panel).
     *
     * @var list<UploadJobStatus>
     */
    private const ACTIVE_STATUSES = [
        UploadJobStatus::Pending,
        UploadJobStatus::Extracting,
        UploadJobStatus::ReadyForReview,
    ];

    /**
     * Statuses surfaced in the `history` group.
     *
     * @var list<UploadJobStatus>
     */
    private const HISTORY_STATUSES = [
        UploadJobStatus::Committed,
        UploadJobStatus::Rejected,
        UploadJobStatus::Failed,
    ];

    /**
     * @param Closure(string, list<scalar|null>): list<array<string, mixed>> $rowFetcher
     */
    public function __construct(
        private Closure $rowFetcher,
    ) {
    }

    /**
     * Production factory wiring the service to QueryUtils. Kept off
     * the constructor so isolated tests do not need to reach for
     * QueryUtils at all.
     */
    public static function default(): self
    {
        $fetcher = static function (string $sql, array $binds): array {
            /** @var list<array<string, mixed>> $rows */
            $rows = QueryUtils::fetchRecords($sql, $binds);
            return $rows;
        };
        return new self($fetcher);
    }

    /**
     * Load the review data for a single upload-job identified by UUID
     * in the context of the given patient.
     *
     * Returns null when:
     *   - The job does not exist.
     *   - The job belongs to a different patient (pid mismatch).
     *   - The sidecar row is missing or its extracted_json is invalid.
     *
     * The extracted_json is decoded here so the controller receives a
     * typed array rather than a raw string. No extracted text reaches
     * DOM data-* attributes — the controller passes the decoded array
     * to PHP's json_encode for embedding in a `<script>` tag guarded
     * by the page's CSP and Cache-Control: private, no-store header.
     */
    public function loadForReview(string $jobUuid, int $patientId): ?ReviewJobView
    {
        $fetcher = $this->rowFetcher;

        /** @var list<array<string, mixed>> $jobRows */
        $jobRows = $fetcher(
            "SELECT j.job_uuid, j.document_id, j.patient_id, j.doc_type, j.status, "
            . "e.extracted_json, d.mimetype "
            . "FROM agentforge_upload_jobs j "
            . "LEFT JOIN agentforge_document_extractions e ON e.document_id = j.document_id "
            . "LEFT JOIN documents d ON d.id = j.document_id "
            . "WHERE j.job_uuid = ? AND j.patient_id = ? LIMIT 1",
            [$jobUuid, $patientId],
        );

        if ($jobRows === []) {
            return null;
        }

        $raw = $jobRows[0];

        $statusRaw = $raw['status'] ?? null;
        if (!is_string($statusRaw)) {
            return null;
        }
        $status = UploadJobStatus::tryFrom($statusRaw);
        if ($status === null) {
            return null;
        }

        $documentIdRaw = $raw['document_id'] ?? null;
        $documentId = is_int($documentIdRaw) ? $documentIdRaw
            : (is_string($documentIdRaw) && ctype_digit($documentIdRaw) ? (int) $documentIdRaw : 0);
        if ($documentId <= 0) {
            return null;
        }

        $patientIdRaw = $raw['patient_id'] ?? null;
        $rowPatientId = is_int($patientIdRaw) ? $patientIdRaw
            : (is_string($patientIdRaw) && ctype_digit($patientIdRaw) ? (int) $patientIdRaw : 0);
        if ($rowPatientId !== $patientId) {
            return null;
        }

        $docTypeRaw = $raw['doc_type'] ?? null;
        $docType = is_string($docTypeRaw) ? $docTypeRaw : '';

        $mimeTypeRaw = $raw['mimetype'] ?? null;
        $mimeType    = is_string($mimeTypeRaw) ? strtolower($mimeTypeRaw) : '';

        $extractedJsonRaw = $raw['extracted_json'] ?? null;
        /** @var array<string, mixed> $extractedJson */
        $extractedJson = [];
        if (is_string($extractedJsonRaw) && $extractedJsonRaw !== '') {
            try {
                $decodedRaw = json_decode($extractedJsonRaw, true, 512, JSON_THROW_ON_ERROR);
                if (is_array($decodedRaw)) {
                    /** @var array<string, mixed> $decodedRaw */
                    $extractedJson = $decodedRaw;
                }
            } catch (\JsonException) {
                // Treat corrupt JSON as empty extraction.
            }
        }

        // Derive page count from source_citation.page_count in the payload.
        $pageCount = 1;
        $sourceCitation = $extractedJson['source_citation'] ?? null;
        if (is_array($sourceCitation)) {
            $rawPageCount = $sourceCitation['page_count'] ?? null;
            if (is_numeric($rawPageCount) && (int) $rawPageCount > 0) {
                $pageCount = (int) $rawPageCount;
            }
        }

        return new ReviewJobView(
            jobUuid:       $jobUuid,
            documentId:    $documentId,
            patientId:     $rowPatientId,
            docType:       $docType,
            mimeType:      $mimeType,
            status:        $status,
            pageCount:     $pageCount,
            extractedJson: $extractedJson,
        );
    }

    /**
     * Run the inbox query for the given patient and return the
     * grouped, sorted, paginated, filtered result.
     */
    public function listForPatient(int $patientId, DocumentInboxQueryOptions $opts): DocumentInboxResult
    {
        $statusFilter = $opts->statusFilter;

        $activeStatuses = self::ACTIVE_STATUSES;
        $historyStatuses = self::HISTORY_STATUSES;

        if ($statusFilter !== null) {
            $activeStatuses = in_array($statusFilter, self::ACTIVE_STATUSES, true)
                ? [$statusFilter] : [];
            $historyStatuses = in_array($statusFilter, self::HISTORY_STATUSES, true)
                ? [$statusFilter] : [];
        }

        $active = $activeStatuses === []
            ? []
            : $this->loadGroup($patientId, $activeStatuses, $opts);
        $history = $historyStatuses === []
            ? []
            : $this->loadGroup($patientId, $historyStatuses, $opts);

        return new DocumentInboxResult($active, $history);
    }

    /**
     * @param non-empty-list<UploadJobStatus> $statuses
     *
     * @return list<DocumentInboxRow>
     */
    private function loadGroup(
        int $patientId,
        array $statuses,
        DocumentInboxQueryOptions $opts,
    ): array {
        // Build a fixed-shape SQL string. All variability is in:
        //   * the IN-list arity (driven by $statuses count),
        //   * the optional provenance filter clause,
        //   * the LIMIT/OFFSET literals (validated as positive ints
        //     in DocumentInboxQueryOptions, so safe to interpolate
        //     after a defensive cast).
        $statusPlaceholders = implode(', ', array_fill(0, count($statuses), '?'));

        $where = "WHERE j.patient_id = ? AND j.status IN ({$statusPlaceholders})";

        if ($opts->provenanceFilter === UploadJobProvenance::HumanCorrected) {
            $where .= " AND e.edited_field_paths IS NOT NULL"
                . " AND JSON_LENGTH(e.edited_field_paths) > 0";
        } elseif ($opts->provenanceFilter === UploadJobProvenance::VlmOnly) {
            $where .= " AND (e.edited_field_paths IS NULL"
                . " OR JSON_LENGTH(e.edited_field_paths) = 0)";
        }

        // pageSize / offset are validated as positive ints in
        // DocumentInboxQueryOptions; safe to interpolate without
        // a redundant cast.
        $limit  = $opts->pageSize;
        $offset = $opts->offset;

        $sql =
            "SELECT j.job_uuid, j.document_id, j.patient_id, j.doc_type, j.status, "
            . "j.error_message, j.started_at AS uploaded_at, "
            . "d.name AS filename, "
            . "d.owner AS uploaded_by_user_id, "
            . "u.username AS uploaded_by_username, "
            . "TRIM(CONCAT(COALESCE(u.fname, ''), ' ', COALESCE(u.lname, ''))) AS uploaded_by_fullname, "
            . "e.id AS extraction_id, "
            . "e.edited_field_paths AS edited_field_paths "
            . "FROM agentforge_upload_jobs j "
            . "LEFT JOIN documents d ON d.id = j.document_id "
            . "LEFT JOIN users u ON u.id = d.owner "
            . "LEFT JOIN agentforge_document_extractions e ON e.document_id = j.document_id "
            . $where . " "
            . "ORDER BY j.started_at DESC, j.id DESC "
            . "LIMIT {$limit} OFFSET {$offset}";

        /** @var list<scalar|null> $binds */
        $binds = [$patientId];
        foreach ($statuses as $status) {
            $binds[] = $status->value;
        }

        $fetcher = $this->rowFetcher;
        $rawRows = $fetcher($sql, $binds);

        $rows = [];
        foreach ($rawRows as $raw) {
            $row = $this->hydrate($raw);
            if ($row !== null) {
                $rows[] = $row;
            }
        }
        return $rows;
    }

    /**
     * @param array<string, mixed> $raw
     */
    private function hydrate(array $raw): ?DocumentInboxRow
    {
        $jobUuid = $raw['job_uuid'] ?? null;
        if (!is_string($jobUuid) || $jobUuid === '') {
            return null;
        }

        $statusRaw = $raw['status'] ?? null;
        if (!is_string($statusRaw)) {
            return null;
        }
        $status = UploadJobStatus::tryFrom($statusRaw);
        if ($status === null) {
            return null;
        }

        $documentId = self::asInt($raw['document_id'] ?? null);
        if ($documentId === null) {
            return null;
        }

        $extractionId = self::asNullableInt($raw['extraction_id'] ?? null);

        $docTypeRaw = $raw['doc_type'] ?? null;
        $docType = is_string($docTypeRaw) ? $docTypeRaw : '';

        $filenameRaw = $raw['filename'] ?? null;
        $filename = is_string($filenameRaw) ? $filenameRaw : '';

        $uploadedByUserId = self::asNullableInt($raw['uploaded_by_user_id'] ?? null);

        $fullname = $raw['uploaded_by_fullname'] ?? null;
        $username = $raw['uploaded_by_username'] ?? null;
        $displayName = self::pickDisplayName(
            is_string($fullname) ? $fullname : null,
            is_string($username) ? $username : null,
        );

        $uploadedAt = self::parseUploadedAt($raw['uploaded_at'] ?? null);
        if ($uploadedAt === null) {
            return null;
        }

        $errorMessage = $raw['error_message'] ?? null;
        $errorMessage = is_string($errorMessage) && $errorMessage !== '' ? $errorMessage : null;

        $editedFieldPaths = self::decodeEditedFieldPaths($raw['edited_field_paths'] ?? null);
        $provenance = ($editedFieldPaths !== null && $editedFieldPaths !== [])
            ? UploadJobProvenance::HumanCorrected
            : UploadJobProvenance::VlmOnly;

        return new DocumentInboxRow(
            jobUuid:               $jobUuid,
            documentId:            $documentId,
            extractionId:          $extractionId,
            docType:               $docType,
            status:                $status,
            provenance:            $provenance,
            filename:              $filename,
            uploadedByUserId:      $uploadedByUserId,
            uploadedByDisplayName: $displayName,
            uploadedAt:            $uploadedAt,
            errorMessage:          $errorMessage,
            editedFieldPaths:      $editedFieldPaths,
        );
    }

    private static function pickDisplayName(?string $fullname, ?string $username): ?string
    {
        if ($fullname !== null) {
            $trimmed = trim($fullname);
            if ($trimmed !== '') {
                return $trimmed;
            }
        }
        if ($username !== null && $username !== '') {
            return $username;
        }
        return null;
    }

    private static function asInt(mixed $value): ?int
    {
        if (is_int($value)) {
            return $value;
        }
        if (is_string($value) && ctype_digit($value)) {
            return (int) $value;
        }
        return null;
    }

    private static function asNullableInt(mixed $value): ?int
    {
        if ($value === null) {
            return null;
        }
        return self::asInt($value);
    }

    private static function parseUploadedAt(mixed $value): ?DateTimeImmutable
    {
        if ($value instanceof DateTimeImmutable) {
            return $value;
        }
        if (!is_string($value) || $value === '') {
            return null;
        }
        try {
            return new DateTimeImmutable($value, new DateTimeZone('UTC'));
        } catch (\DateMalformedStringException) {
            return null;
        }
    }

    /**
     * Decode the `edited_field_paths` JSON column to a list of dotted
     * path strings. Non-string entries and decode failures collapse to
     * `null` so the provenance flag derivation is total.
     *
     * @return list<string>|null
     */
    private static function decodeEditedFieldPaths(mixed $value): ?array
    {
        if ($value === null) {
            return null;
        }
        if (is_array($value)) {
            return self::filterStringList($value);
        }
        if (!is_string($value) || $value === '') {
            return null;
        }
        try {
            $decoded = json_decode($value, true, 512, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            return null;
        }
        if (!is_array($decoded)) {
            return null;
        }
        return self::filterStringList($decoded);
    }

    /**
     * @param array<mixed> $values
     *
     * @return list<string>
     */
    private static function filterStringList(array $values): array
    {
        $out = [];
        foreach ($values as $v) {
            if (is_string($v)) {
                $out[] = $v;
            }
        }
        return $out;
    }
}
