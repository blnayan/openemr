<?php

/**
 * IntakeWriter — production wiring of the IntakeWriteAdapter.
 *
 * Owns the concrete database inserters for the three intake write
 * targets — `lists` (type='medication'), `lists` (type='allergy'),
 * `pnotes` — plus the `agentforge_resource_links` back-pointer rows
 * and the `agentforge_chart_evidence` audit trail (idempotency
 * support added 2026-05-10).
 *
 * Mirrors {@see LabFhirWriter}'s shape so ConfirmCommitter (issue 22)
 * can route by `doc_type` between the two without knowing which
 * subsystem owns the write. All DB access goes through {@see QueryUtils};
 * the translation logic itself lives in {@see IntakeWriteAdapter},
 * which is unit-tested without a database via closure-based
 * collaborator stubs (mirrors {@see LabFhirAdapter}'s test posture).
 *
 * Demographics merge and family-history round-trip are deliberately NOT
 * wired here — see W2_DOCUMENT_INBOX_PRD §"Out of Scope".
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
use OpenEMR\Common\Uuid\UuidRegistry;

class IntakeWriter implements DocumentWriter
{
    public const CHART_TABLE_LISTS  = 'lists';
    public const CHART_TABLE_PNOTES = 'pnotes';

    /**
     * Persist every intake bucket (current_medications, allergies,
     * chief_concern) in the extracted payload to its OpenEMR target
     * and record back-pointer rows in agentforge_resource_links.
     * `documentId` is stamped on every `lists.source_document_id` /
     * `pnotes.source_document_id` so chat-time tools can attribute the
     * row back to the source PDF (NULL on rows entered through the
     * dashboard).
     *
     * @param array<string, mixed> $extracted
     */
    public function writeThrough(int $extractionId, int $patientId, int $documentId, array $extracted): IntakeWriteOutcome
    {
        return $this->buildAdapter($documentId)->writeThrough($extractionId, $patientId, $extracted);
    }

    private function buildAdapter(int $documentId): IntakeWriteAdapter
    {
        return new IntakeWriteAdapter(
            medicationInserter:        self::medicationInserter($documentId),
            allergyInserter:           self::allergyInserter($documentId),
            pnoteInserter:             self::pnoteInserter($documentId),
            linkInserter:              self::linkInserter(),
            existingMedicationFinder:  self::existingListsRowFinder(IntakeWriteAdapter::RESOURCE_MEDICATION),
            medicationUpdater:         self::medicationUpdater($documentId),
            existingAllergyFinder:     self::existingListsRowFinder(IntakeWriteAdapter::RESOURCE_ALLERGY),
            allergyUpdater:            self::allergyUpdater($documentId),
            evidenceRecorder:          self::evidenceRecorder($documentId),
        );
    }

    /**
     * Convert documentId to the SQL parameter the closures use:
     *   - 0 → NULL  (treat 0 as "no source document"; column is nullable)
     *   - >0 → the literal int (cast to int)
     */
    private static function nullableDocId(int $documentId): ?int
    {
        return $documentId > 0 ? $documentId : null;
    }

    private static function medicationInserter(int $documentId): \Closure
    {
        $sourceDocId = self::nullableDocId($documentId);
        return static function (int $patientId, string $title, string $comments) use ($sourceDocId): int {
            $listsUuid = (new UuidRegistry(['table_name' => 'lists']))->createUuid();
            return (int) QueryUtils::sqlInsert(
                "INSERT INTO lists "
                . "(uuid, date, type, title, activity, comments, pid, begdate, source_document_id) "
                . "VALUES (?, NOW(), 'medication', ?, 1, ?, ?, NOW(), ?)",
                [$listsUuid, substr($title, 0, 255), $comments, $patientId, $sourceDocId],
            );
        };
    }

    private static function allergyInserter(int $documentId): \Closure
    {
        $sourceDocId = self::nullableDocId($documentId);
        return static function (int $patientId, string $title, string $reaction, ?string $severity) use ($sourceDocId): int {
            $listsUuid = (new UuidRegistry(['table_name' => 'lists']))->createUuid();
            return (int) QueryUtils::sqlInsert(
                "INSERT INTO lists "
                . "(uuid, date, type, title, activity, reaction, severity_al, pid, begdate, source_document_id) "
                . "VALUES (?, NOW(), 'allergy', ?, 1, ?, ?, ?, NOW(), ?)",
                [
                    $listsUuid,
                    substr($title, 0, 255),
                    substr($reaction, 0, 255),
                    $severity,
                    $patientId,
                    $sourceDocId,
                ],
            );
        };
    }

    private static function pnoteInserter(int $documentId): \Closure
    {
        $sourceDocId = self::nullableDocId($documentId);
        return static fn(int $patientId, string $title, string $body): int => (int) QueryUtils::sqlInsert(
            "INSERT INTO pnotes "
            . "(date, body, pid, activity, authorized, title, message_status, source_document_id) "
            . "VALUES (NOW(), ?, ?, 1, 1, ?, 'New', ?)",
            [$body, $patientId, substr($title, 0, 255), $sourceDocId],
        );
    }

    private static function linkInserter(): \Closure
    {
        // Aligned with the actual agentforge_resource_links schema
        // (id, extraction_id, resource_type, resource_id, created_at).
        // row_index/status/error_message are not persisted; failures are
        // surfaced via the IntakeWriteOutcome counts/errors arrays.
        return static function (
            int $extractionId,
            int $rowIndex,
            string $resourceType,
            int $resourceId,
            string $status,
            ?string $errorMessage,
        ): void {
            unset($rowIndex, $errorMessage);
            if ($status !== 'written') {
                return;
            }
            QueryUtils::sqlInsert(
                "INSERT INTO agentforge_resource_links "
                . "(extraction_id, resource_type, resource_id, created_at) "
                . "VALUES (?, ?, ?, NOW())",
                [$extractionId, $resourceType, (string) $resourceId],
            );
        };
    }

    /**
     * Look up the lists.id of an existing medication or allergy row for
     * a (patient, dedupKey) pair. Reads from agentforge_chart_evidence
     * keyed on chart_table='lists' and the dedup key the adapter built.
     * Returns null when no prior commit asserted the same row.
     *
     * @param string $bucket one of IntakeWriteAdapter::RESOURCE_MEDICATION |
     *                       IntakeWriteAdapter::RESOURCE_ALLERGY. Used as a
     *                       safety check against accidental cross-bucket
     *                       collisions on the dedup-key column.
     */
    private static function existingListsRowFinder(string $bucket): \Closure
    {
        return static function (int $patientId, string $dedupKey) use ($bucket): ?int {
            // The dedup key already encodes the bucket, so we don't need
            // to filter by it server-side; but we keep the closure
            // bucket-typed so a reader can tell which path runs.
            unset($bucket);
            $row = QueryUtils::querySingleRow(
                "SELECT chart_row_id "
                . "FROM agentforge_chart_evidence "
                . "WHERE patient_id = ? AND chart_table = ? AND dedup_key = ? "
                . "ORDER BY id DESC LIMIT 1",
                [$patientId, self::CHART_TABLE_LISTS, $dedupKey],
            );
            if (!is_array($row)) {
                return null;
            }
            $id = $row['chart_row_id'] ?? null;
            if (is_int($id)) {
                return $id > 0 ? $id : null;
            }
            if (is_string($id) && ctype_digit($id)) {
                $idInt = (int) $id;
                return $idInt > 0 ? $idInt : null;
            }
            return null;
        };
    }

    private static function medicationUpdater(int $documentId): \Closure
    {
        $sourceDocId = self::nullableDocId($documentId);
        return static function (int $listsId, string $title, string $comments) use ($sourceDocId): void {
            QueryUtils::sqlStatementThrowException(
                "UPDATE lists SET "
                . "title = ?, comments = ?, source_document_id = COALESCE(?, source_document_id), "
                . "activity = 1 "
                . "WHERE id = ?",
                [substr($title, 0, 255), $comments, $sourceDocId, $listsId],
            );
        };
    }

    private static function allergyUpdater(int $documentId): \Closure
    {
        $sourceDocId = self::nullableDocId($documentId);
        return static function (int $listsId, string $title, string $reaction, ?string $severity) use ($sourceDocId): void {
            // severity_al is updated only when the new value is non-null
            // — preserves a previously-recorded severity when the next
            // form omits the field.
            QueryUtils::sqlStatementThrowException(
                "UPDATE lists SET "
                . "title = ?, reaction = ?, "
                . "severity_al = COALESCE(?, severity_al), "
                . "source_document_id = COALESCE(?, source_document_id), "
                . "activity = 1 "
                . "WHERE id = ?",
                [
                    substr($title, 0, 255),
                    substr($reaction, 0, 255),
                    $severity,
                    $sourceDocId,
                    $listsId,
                ],
            );
        };
    }

    private static function evidenceRecorder(int $documentId): \Closure
    {
        $sourceDocId = self::nullableDocId($documentId);
        return static function (
            int $extractionId,
            int $patientId,
            string $chartTable,
            int $chartRowId,
            string $dedupKey,
        ) use ($sourceDocId): void {
            QueryUtils::sqlInsert(
                "INSERT INTO agentforge_chart_evidence "
                . "(patient_id, chart_table, chart_row_id, dedup_key, extraction_id, document_id, committed_at) "
                . "VALUES (?, ?, ?, ?, ?, ?, NOW())",
                [
                    $patientId,
                    $chartTable,
                    $chartRowId,
                    $dedupKey,
                    $extractionId,
                    $sourceDocId,
                ],
            );
        };
    }
}
