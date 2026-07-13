<?php

/**
 * InboxRowDeleter — destructive cascade for a single upload-job.
 *
 * Cascade order:
 *
 *   1. agentforge_resource_links — back-pointer rows.
 *   2. agentforge_document_extractions — sidecar row.
 *   3. agentforge_upload_jobs — the inbox-visible row.
 *   4. categories_to_documents — the Documents-tab category linkage.
 *   5. documents — the OpenEMR document row + the file on disk if its
 *      url is a file:// URI living inside the OpenEMR sites/ tree.
 *
 * The FHIR / `lists` write-throughs that a `committed` job emitted
 * (procedure_order / procedure_report / procedure_result, lists
 * medications / allergies, pnotes chief concern) are intentionally
 * NOT removed — those records are canonical patient-chart data and
 * the user is responsible for cleaning them up via the OpenEMR
 * surfaces that own them.
 *
 * Idempotency: a half-applied cascade left behind by a transaction
 * failure is safely re-runnable — each DELETE is a no-op once its
 * row is gone, and unlink() of an already-missing file is silenced.
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

final readonly class InboxRowDeleter
{
    /**
     * Delete the AgentForge-owned cascade plus the underlying OpenEMR
     * document row + file for a single job.
     *
     * Caller is responsible for verifying the job exists and is owned
     * by the session patient — see
     * {@see \OpenEMR\AgentForge\Controller\DeleteJobController}.
     */
    public function deleteByJobUuid(string $jobUuid): void
    {
        // Capture document ids referenced by the job before we delete
        // the upload_jobs row that joins them.
        /** @var list<array{document_id: int|string|null}> $docRows */
        $docRows = QueryUtils::fetchRecords(
            "SELECT document_id FROM agentforge_upload_jobs WHERE job_uuid = ?",
            [$jobUuid],
        );
        $documentIds = [];
        foreach ($docRows as $r) {
            $idRaw = $r['document_id'] ?? null;
            $id    = is_int($idRaw) ? $idRaw
                : (is_string($idRaw) && ctype_digit($idRaw) ? (int) $idRaw : 0);
            if ($id > 0) {
                $documentIds[] = $id;
            }
        }

        QueryUtils::sqlStatementThrowException(
            "DELETE rl FROM agentforge_resource_links rl "
            . "INNER JOIN agentforge_document_extractions e "
            . "ON e.id = rl.extraction_id "
            . "INNER JOIN agentforge_upload_jobs j "
            . "ON j.document_id = e.document_id "
            . "WHERE j.job_uuid = ?",
            [$jobUuid],
        );
        QueryUtils::sqlStatementThrowException(
            "DELETE e FROM agentforge_document_extractions e "
            . "INNER JOIN agentforge_upload_jobs j "
            . "ON j.document_id = e.document_id "
            . "WHERE j.job_uuid = ?",
            [$jobUuid],
        );
        QueryUtils::sqlStatementThrowException(
            "DELETE FROM agentforge_upload_jobs WHERE job_uuid = ?",
            [$jobUuid],
        );

        foreach ($documentIds as $documentId) {
            $this->deleteDocument($documentId);
        }
    }

    private function deleteDocument(int $documentId): void
    {
        // Look up the file URL before we drop the row so we can unlink
        // a filesystem-backed payload. Couchdb / S3 / other schemes are
        // left to the canonical OpenEMR Document::process_deleted path
        // — best-effort filesystem cleanup only.
        $row = QueryUtils::querySingleRow(
            "SELECT url FROM documents WHERE id = ? LIMIT 1",
            [$documentId],
        );
        $url = is_array($row) && isset($row['url']) && is_string($row['url'])
            ? $row['url']
            : '';

        QueryUtils::sqlStatementThrowException(
            "DELETE FROM categories_to_documents WHERE document_id = ?",
            [$documentId],
        );
        QueryUtils::sqlStatementThrowException(
            "DELETE FROM documents WHERE id = ?",
            [$documentId],
        );

        if (str_starts_with($url, 'file://')) {
            $path = substr($url, strlen('file://'));
            if ($path !== '' && is_file($path)) {
                @unlink($path);
            }
        }
    }
}
