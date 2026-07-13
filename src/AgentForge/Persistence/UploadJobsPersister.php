<?php

/**
 * UploadJobsPersister — single owner of writes to the
 * `agentforge_upload_jobs` table that drives the Document Inbox
 * upload-progress stepper and gives the FHIR / `lists` write-through
 * partial-success a place to land.
 *
 * The Document Inbox rework (W2_DOCUMENT_INBOX_PRD.md) replaces the
 * stringly-typed status writes with transitions through the
 * {@see UploadJobStatusMachine}. State writes route through
 * {@see applyTransition()}; legacy convenience helpers
 * (`markDone`, `markDonePartial`, `markFailed`) remain so the existing
 * Documents-tab listener path still compiles, but new code must reach
 * for the typed transition method.
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
use OpenEMR\AgentForge\Domain\UploadJobStatusMachine;
use OpenEMR\AgentForge\Domain\UploadJobTransition;
use OpenEMR\Common\Database\QueryUtils;

class UploadJobsPersister
{
    /**
     * Insert a fresh job row for an upload that already has a known
     * document id (the Documents-tab path). Returns the (possibly
     * client-supplied) job_uuid.
     *
     * `$preferredJobUuid` lets the browser pre-allocate a UUID so it
     * can begin polling `status.php` BEFORE the upload XHR completes
     * (the XHR blocks for the synchronous sidecar extraction). Pass
     * an empty string to fall back to the server-generated id.
     * Validated to 32 hex chars to match the legacy `bin2hex(random_bytes(16))`
     * format and prevent SQL surprises.
     *
     * `$fileHashSha256` carries the upload's SHA-256 (lowercase 64-char
     * hex) for the soft duplicate-warning advisory. Empty string when
     * the caller didn't compute one — the column stays NULL and the
     * advisory simply doesn't fire for that row.
     */
    public function insertForDocument(
        int $documentId,
        int $patientId,
        string $docType,
        string $preferredJobUuid = '',
        string $fileHashSha256 = '',
    ): string {
        $jobUuid = preg_match('/^[a-f0-9]{32}$/', $preferredJobUuid) === 1
            ? $preferredJobUuid
            : bin2hex(random_bytes(16));
        $hash = preg_match('/^[a-f0-9]{64}$/', $fileHashSha256) === 1
            ? $fileHashSha256
            : null;
        QueryUtils::sqlInsert(
            "INSERT INTO agentforge_upload_jobs "
            . "(job_uuid, document_id, patient_id, doc_type, file_hash_sha256, status, started_at) "
            . "VALUES (?, ?, ?, ?, ?, 'pending', NOW())",
            [$jobUuid, $documentId, $patientId, $docType, $hash],
        );
        return $jobUuid;
    }

    /**
     * Soft duplicate-warning lookup. Returns the most recent committed
     * upload-job for the given patient whose `file_hash_sha256` matches
     * the one provided, or NULL when no such row exists.
     *
     * The returned tuple carries the prior job_uuid, document filename
     * (so the UI can render "you committed `<name>` on …"), and
     * commit timestamp. The caller — the upload-time advisory in
     * UploadController — surfaces this on the response so the inbox JS
     * can show a non-blocking banner.
     *
     * @return array{job_uuid: string, filename: string, committed_at: string}|null
     */
    public function findCommittedDuplicate(int $patientId, string $fileHashSha256): ?array
    {
        if (preg_match('/^[a-f0-9]{64}$/', $fileHashSha256) !== 1) {
            return null;
        }
        // We join to documents so the banner can name the prior file.
        // Match on `committed` only — `done` is a legacy alias on rows
        // that pre-date the W2 review flow and was always treated as
        // terminal-success, so we treat it the same here. Failed and
        // rejected uploads don't count as duplicates.
        $row = QueryUtils::querySingleRow(
            "SELECT j.job_uuid, COALESCE(d.name, '') AS name, "
            . "COALESCE(j.finished_at, j.updated_at, j.created_at) AS committed_at "
            . "FROM agentforge_upload_jobs j "
            . "LEFT JOIN documents d ON d.id = j.document_id "
            . "WHERE j.patient_id = ? "
            . "  AND j.file_hash_sha256 = ? "
            . "  AND j.status IN ('committed', 'done', 'done_partial') "
            . "ORDER BY j.id DESC LIMIT 1",
            [$patientId, $fileHashSha256],
        );
        if (!is_array($row)) {
            return null;
        }
        $jobUuid = $row['job_uuid'] ?? null;
        if (!is_string($jobUuid) || $jobUuid === '') {
            return null;
        }
        $filename = $row['name'] ?? '';
        $filename = is_string($filename) ? $filename : '';
        $committedAt = $row['committed_at'] ?? '';
        $committedAt = is_string($committedAt) ? $committedAt : '';
        return [
            'job_uuid' => $jobUuid,
            'filename' => $filename,
            'committed_at' => $committedAt,
        ];
    }

    public function markDone(string $jobUuid): void
    {
        QueryUtils::sqlStatementThrowException(
            "UPDATE agentforge_upload_jobs SET status = 'done', finished_at = NOW() WHERE job_uuid = ?",
            [$jobUuid],
        );
    }

    public function markDonePartial(string $jobUuid, string $errorMessage): void
    {
        QueryUtils::sqlStatementThrowException(
            "UPDATE agentforge_upload_jobs SET status = 'done_partial', error_message = ?, finished_at = NOW() WHERE job_uuid = ?",
            [$errorMessage, $jobUuid],
        );
    }

    public function markFailed(string $jobUuid, string $errorMessage): void
    {
        QueryUtils::sqlStatementThrowException(
            "UPDATE agentforge_upload_jobs SET status = 'failed', error_message = ?, finished_at = NOW() WHERE job_uuid = ?",
            [$errorMessage, $jobUuid],
        );
    }

    /**
     * Returns true if at least one job row already exists for this
     * document_id. Used by the Documents-tab subscriber to skip
     * re-processing documents whose extraction was already kicked off
     * by the legacy custom-widget upload entry point (which inserts
     * its own job row before firing PatientDocumentCreatedEvent).
     */
    public function hasJobForDocument(int $documentId): bool
    {
        $row = QueryUtils::querySingleRow(
            "SELECT id FROM agentforge_upload_jobs WHERE document_id = ? LIMIT 1",
            [$documentId],
        );
        return is_array($row) && isset($row['id']);
    }

    /**
     * Load the (status, doc_type, document_id, patient_id) tuple for an
     * upload-job by its uuid. Returns null when the job is not found.
     *
     * Used by ConfirmCommitter to resolve doc-type routing and to
     * enforce the strict-status invariant before writing.
     */
    public function loadJob(string $jobUuid): ?UploadJobRow
    {
        $row = QueryUtils::querySingleRow(
            "SELECT job_uuid, document_id, patient_id, doc_type, status "
            . "FROM agentforge_upload_jobs WHERE job_uuid = ? LIMIT 1",
            [$jobUuid],
        );
        if (!is_array($row)) {
            return null;
        }

        $statusRaw = $row['status'] ?? null;
        if (!is_string($statusRaw)) {
            return null;
        }
        $status = UploadJobStatus::tryFrom($statusRaw);
        if ($status === null) {
            return null;
        }

        $documentIdRaw = $row['document_id'] ?? null;
        $documentId    = is_int($documentIdRaw) ? $documentIdRaw
            : (is_string($documentIdRaw) && ctype_digit($documentIdRaw) ? (int) $documentIdRaw : 0);

        $patientIdRaw = $row['patient_id'] ?? null;
        $patientId    = is_int($patientIdRaw) ? $patientIdRaw
            : (is_string($patientIdRaw) && ctype_digit($patientIdRaw) ? (int) $patientIdRaw : 0);

        $docTypeRaw = $row['doc_type'] ?? null;
        $docType    = is_string($docTypeRaw) ? $docTypeRaw : '';

        return new UploadJobRow(
            jobUuid:    $jobUuid,
            documentId: $documentId,
            patientId:  $patientId,
            docType:    $docType,
            status:     $status,
        );
    }

    /**
     * Load the richer status projection the Document Inbox poller (issue
     * 26) consumes. Returns null when the job is not found.
     *
     * Selects the same columns as {@see loadJob()} plus the diagnostic
     * timestamps and error fields the inbox stepper renders. PHI never
     * appears in this projection — filenames, extracted text, and
     * bounding boxes live elsewhere; this is the on-the-wire surface for
     * the polling endpoint, which sets `Cache-Control: private,
     * no-store` and is gated on patient-scope ACL by the HTTP layer.
     */
    public function loadStatusView(string $jobUuid): ?UploadJobStatusView
    {
        $row = QueryUtils::querySingleRow(
            "SELECT job_uuid, document_id, patient_id, doc_type, status, "
            . "error_code, error_message, created_at, updated_at "
            . "FROM agentforge_upload_jobs WHERE job_uuid = ? LIMIT 1",
            [$jobUuid],
        );
        if (!is_array($row)) {
            return null;
        }

        $statusRaw = $row['status'] ?? null;
        if (!is_string($statusRaw)) {
            return null;
        }
        $status = UploadJobStatus::tryFrom($statusRaw);
        if ($status === null) {
            return null;
        }

        $documentIdRaw = $row['document_id'] ?? null;
        $documentId    = is_int($documentIdRaw) ? $documentIdRaw
            : (is_string($documentIdRaw) && ctype_digit($documentIdRaw) ? (int) $documentIdRaw : 0);

        $patientIdRaw = $row['patient_id'] ?? null;
        $patientId    = is_int($patientIdRaw) ? $patientIdRaw
            : (is_string($patientIdRaw) && ctype_digit($patientIdRaw) ? (int) $patientIdRaw : 0);

        $docTypeRaw = $row['doc_type'] ?? null;
        $docType    = is_string($docTypeRaw) ? $docTypeRaw : '';

        return new UploadJobStatusView(
            jobUuid:      $jobUuid,
            documentId:   $documentId,
            patientId:    $patientId,
            docType:      $docType,
            status:       $status,
            errorCode:    self::nullableString($row['error_code'] ?? null),
            errorMessage: self::nullableString($row['error_message'] ?? null),
            createdAt:    self::nullableString($row['created_at'] ?? null),
            updatedAt:    self::nullableString($row['updated_at'] ?? null),
        );
    }

    private static function nullableString(mixed $value): ?string
    {
        if ($value === null) {
            return null;
        }
        return is_string($value) ? $value : null;
    }

    /**
     * Apply a transition to the upload-job's status, computing the new
     * status via {@see UploadJobStatusMachine} and persisting it.
     *
     * Throws {@see InvalidUploadJobTransitionException} (from the
     * machine) when the transition is illegal from $currentStatus,
     * including any transition out of a terminal status.
     */
    public function applyTransition(
        string $jobUuid,
        UploadJobStatus $currentStatus,
        UploadJobTransition $transition,
        UploadJobStatusMachine $machine,
        ?string $errorMessage = null,
    ): UploadJobStatus {
        $next = $machine->next($currentStatus, $transition);
        $this->writeStatus($jobUuid, $next, $errorMessage);
        return $next;
    }

    /**
     * Write the given status to disk. Uses the enum's backing string
     * value so PHPStan-checked transitions land verbatim in the
     * status column. Stamps `finished_at = NOW()` when the new status
     * is terminal so the inbox can sort by completion time.
     */
    private function writeStatus(
        string $jobUuid,
        UploadJobStatus $status,
        ?string $errorMessage,
    ): void {
        if ($status->isTerminal()) {
            QueryUtils::sqlStatementThrowException(
                "UPDATE agentforge_upload_jobs "
                . "SET status = ?, error_message = ?, finished_at = NOW() "
                . "WHERE job_uuid = ?",
                [$status->value, $errorMessage, $jobUuid],
            );
            return;
        }

        QueryUtils::sqlStatementThrowException(
            "UPDATE agentforge_upload_jobs "
            . "SET status = ?, error_message = ? "
            . "WHERE job_uuid = ?",
            [$status->value, $errorMessage, $jobUuid],
        );
    }
}
