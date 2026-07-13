<?php

/**
 * SidecarPersister — single owner of writes to the
 * `agentforge_document_extractions` sidecar table.
 *
 * Owns three responsibilities:
 *   1. The initial extraction-row insert (called by ExtractionDispatcher
 *      after the agent service returns parsed JSON).
 *   2. The reviewer provenance stamp written by ConfirmCommitter on
 *      confirm or whole-document reject (the four columns landed by the
 *      `20260506130001` migration: reviewed_by_user_id, reviewed_at,
 *      review_decision, edited_field_paths).
 *   3. Read paths the rework needs: idempotency check by document_id
 *      and the (id + extracted_json) projection ConfirmCommitter feeds
 *      into the doc-type writer.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\AgentForge\Persistence;

use OpenEMR\Common\Database\QueryUtils;

class SidecarPersister
{
    public const REVIEW_DECISION_COMMITTED = 'committed';
    public const REVIEW_DECISION_REJECTED  = 'rejected';

    /**
     * @param array<string, mixed> $extracted
     * @return int the new agentforge_document_extractions.id
     */
    public function persist(
        int $documentId,
        int $patientId,
        string $docType,
        string $schemaVersion,
        array $extracted,
    ): int {
        $extractedJson = json_encode($extracted, JSON_THROW_ON_ERROR);
        return (int) QueryUtils::sqlInsert(
            "INSERT INTO agentforge_document_extractions "
            . "(document_id, patient_id, doc_type, schema_version, extracted_json, "
            . " patient_match_status, injection_suspected, extraction_status, created_at, updated_at) "
            . "VALUES (?, ?, ?, ?, ?, 'unverifiable', 0, 'complete', NOW(), NOW())",
            [$documentId, $patientId, $docType, $schemaVersion, $extractedJson],
        );
    }

    /**
     * Returns true if a sidecar row already exists for this
     * document_id. Used by the subscriber to make re-firing the
     * created-event idempotent.
     */
    public function existsForDocument(int $documentId): bool
    {
        $row = QueryUtils::querySingleRow(
            "SELECT id FROM agentforge_document_extractions WHERE document_id = ? LIMIT 1",
            [$documentId],
        );
        return is_array($row) && isset($row['id']);
    }

    /**
     * Load the (extraction_id, decoded extracted_json) projection for a
     * given document_id. Returns null when no sidecar row exists.
     *
     * ConfirmCommitter calls this to (a) compare the editor-submitted
     * JSON against the original VLM payload to populate
     * `edited_field_paths`, and (b) hand the extraction_id to the
     * doc-type writer so it can emit `agentforge_resource_links`
     * back-pointers.
     */
    public function loadByDocumentId(int $documentId): ?ExtractionRow
    {
        $row = QueryUtils::querySingleRow(
            "SELECT id, doc_type, patient_id, extracted_json "
            . "FROM agentforge_document_extractions WHERE document_id = ? LIMIT 1",
            [$documentId],
        );
        if (!is_array($row)) {
            return null;
        }

        $idRaw = $row['id'] ?? null;
        $extractionId = is_int($idRaw) ? $idRaw
            : (is_string($idRaw) && ctype_digit($idRaw) ? (int) $idRaw : 0);
        if ($extractionId <= 0) {
            return null;
        }

        $jsonRaw = $row['extracted_json'] ?? null;
        $jsonStr = is_string($jsonRaw) ? $jsonRaw : '';
        $decoded = $this->decodeExtractedJson($jsonStr);

        $patientIdRaw = $row['patient_id'] ?? null;
        $patientId    = is_int($patientIdRaw) ? $patientIdRaw
            : (is_string($patientIdRaw) && ctype_digit($patientIdRaw) ? (int) $patientIdRaw : 0);

        $docTypeRaw = $row['doc_type'] ?? null;
        $docType    = is_string($docTypeRaw) ? $docTypeRaw : '';

        return new ExtractionRow(
            extractionId: $extractionId,
            documentId:   $documentId,
            patientId:    $patientId,
            docType:      $docType,
            originalJson: $decoded,
        );
    }

    /**
     * Stamp the reviewer-provenance columns on an extraction row.
     *
     * `$editedFieldPaths` is the output of
     * {@see EditedFieldPathDiffer::diff()}; it is persisted as a JSON
     * array. Pass `null` to leave the column NULL (the convention for
     * whole-document reject, where there is no edited payload to diff).
     *
     * @param list<string>|null $editedFieldPaths
     */
    public function stampReview(
        int $extractionId,
        int $reviewerUserId,
        string $reviewDecision,
        ?array $editedFieldPaths,
    ): void {
        $editedJson = $editedFieldPaths === null
            ? null
            : json_encode($editedFieldPaths, JSON_THROW_ON_ERROR);

        QueryUtils::sqlStatementThrowException(
            "UPDATE agentforge_document_extractions "
            . "SET reviewed_by_user_id = ?, reviewed_at = NOW(), "
            . "    review_decision = ?, edited_field_paths = ?, updated_at = NOW() "
            . "WHERE id = ?",
            [$reviewerUserId, $reviewDecision, $editedJson, $extractionId],
        );
    }

    /**
     * Replace the persisted extracted_json with the reviewer-edited
     * payload. Called by ConfirmCommitter so the canonical sidecar row
     * reflects what the clinician confirmed (the original VLM payload
     * is recoverable from the `edited_field_paths` diff if needed).
     *
     * @param array<string, mixed> $editedJson
     */
    public function updateExtractedJson(int $extractionId, array $editedJson): void
    {
        $encoded = json_encode($editedJson, JSON_THROW_ON_ERROR);
        QueryUtils::sqlStatementThrowException(
            "UPDATE agentforge_document_extractions "
            . "SET extracted_json = ?, updated_at = NOW() "
            . "WHERE id = ?",
            [$encoded, $extractionId],
        );
    }

    /**
     * Coerce the extractor's decoded JSON body into the string-keyed
     * shape the persistence layer expects. Non-string keys (a JSON
     * array at the top level) collapse to an empty payload —
     * extractor envelopes are always objects, so this is a defensive
     * narrowing for PHPStan rather than a behavioural change.
     *
     * @param array<mixed>|null $extracted
     *
     * @return array<string, mixed>
     */
    public function normalizePayload(?array $extracted): array
    {
        if ($extracted === null) {
            return [];
        }
        $out = [];
        foreach ($extracted as $key => $value) {
            if (is_string($key)) {
                $out[$key] = $value;
            }
        }
        return $out;
    }

    /**
     * Defensive decode of the persisted extracted_json column to the
     * string-keyed shape downstream consumers expect. Empty / malformed
     * payloads collapse to `[]` — the only callers (ConfirmCommitter)
     * compare against the editor-submitted JSON, and an empty original
     * means "every key in the edit is a path".
     *
     * @return array<string, mixed>
     */
    private function decodeExtractedJson(string $json): array
    {
        if ($json === '') {
            return [];
        }
        try {
            $decoded = json_decode($json, true, 512, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            return [];
        }
        if (!is_array($decoded)) {
            return [];
        }
        return $this->normalizePayload($decoded);
    }
}
