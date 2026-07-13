<?php

/**
 * ConfirmCommitter — single path from a `ready_for_review` sidecar to
 * a FHIR / `lists` write-through.
 *
 * The Document Inbox rework defers FHIR write-through until a clinician
 * has reviewed the extracted facts. ExtractionDispatcher persists the
 * sidecar and parks the upload-job in `ready_for_review`; this service
 * is the only consumer of that status that produces FHIR Observations
 * (lab_pdf) or `lists` rows (intake_form, issue 23).
 *
 * Routing is by `doc_type` recorded on the sidecar at extraction time:
 *   - `lab_pdf`     → LabFhirWriter
 *   - `intake_form` → IntakeWriter (issue 23, plugged into the same map)
 *
 * Strict-status invariant: confirm() and reject() require the
 * upload-job to be in {@see UploadJobStatus::ReadyForReview}. A
 * double-confirm or a stale browser tab causes
 * {@see UploadJobNotReadyForReviewException} which the HTTP layer
 * (issue 26) maps to HTTP 409 Conflict. Writers therefore never need
 * to branch on "what if I already wrote this?".
 *
 * Provenance: on success the reviewer's user id, the current
 * timestamp, the review decision (`committed` | `rejected`), and the
 * JSON-path list of fields the reviewer edited away from the VLM's
 * output are stamped onto the sidecar row (the four columns the
 * `20260506130001` migration introduced).
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\AgentForge\Persistence;

use OpenEMR\AgentForge\Domain\EditedFieldPathDiffer;
use OpenEMR\AgentForge\Domain\UploadJobStatus;
use OpenEMR\AgentForge\Domain\UploadJobStatusMachine;
use OpenEMR\AgentForge\Domain\UploadJobTransition;
use OpenEMR\AgentForge\Exception\UnknownDocTypeException;
use OpenEMR\AgentForge\Exception\UploadJobNotReadyForReviewException;

final readonly class ConfirmCommitter
{
    /**
     * @var array<string, DocumentWriter>
     */
    private array $writersByDocType;

    /**
     * @param LabFhirWriter                 $labWriter        the canonical lab_pdf writer; pre-pinned
     *                                                        into the writer map at the
     *                                                        `lab_pdf` key.
     * @param array<string, DocumentWriter> $writersByDocType additional writers keyed by doc_type
     *                                                        (e.g. `intake_form` once issue 23
     *                                                        lands).
     */
    public function __construct(
        LabFhirWriter $labWriter,
        array $writersByDocType,
        private UploadJobsPersister $jobs,
        private SidecarPersister $sidecar,
        private UploadJobStatusMachine $statusMachine,
    ) {
        $writersByDocType['lab_pdf'] = $labWriter;
        $this->writersByDocType = $writersByDocType;
    }

    /**
     * Confirm the reviewer's edits, run the doc-type writer, stamp
     * provenance, and transition the upload-job to `committed`.
     *
     * @param array<string, mixed> $editedJson the reviewer-edited payload
     *
     * @throws UploadJobNotReadyForReviewException when the upload-job is
     *         not currently in `ready_for_review`. The HTTP layer maps
     *         this to 409 Conflict.
     * @throws UnknownDocTypeException when the doc_type recorded on the
     *         upload-job has no registered writer in the writer map.
     */
    public function confirm(string $jobUuid, array $editedJson, int $userId): WriteOutcome
    {
        $job = $this->loadAndAssertReadyForReview($jobUuid);
        $extraction = $this->loadExtractionOrThrow($job);
        $writer = $this->resolveWriter($job->docType);

        $editedFieldPaths = EditedFieldPathDiffer::diff(
            $extraction->originalJson,
            $editedJson,
        );

        // Persist the reviewer-edited payload as the canonical sidecar
        // body BEFORE the doc-type writer fires, so the writer reads
        // from disk-equivalent JSON rather than relying on caller state.
        $this->sidecar->updateExtractedJson($extraction->extractionId, $editedJson);

        $outcome = $writer->writeThrough(
            $extraction->extractionId,
            $extraction->patientId,
            $job->documentId,
            $editedJson,
        );

        $this->sidecar->stampReview(
            $extraction->extractionId,
            $userId,
            SidecarPersister::REVIEW_DECISION_COMMITTED,
            $editedFieldPaths,
        );

        $this->jobs->applyTransition(
            $jobUuid,
            UploadJobStatus::ReadyForReview,
            UploadJobTransition::Confirm,
            $this->statusMachine,
            self::partialSuccessMessage($outcome),
        );

        return $outcome;
    }

    /**
     * Build the upload-job's `error_message` value for a confirmed
     * write-through. A clean outcome stays NULL; a partial outcome
     * carries a stable `partial: …` string the inbox UI can detect
     * without re-reading per-row resource_links.
     *
     * Total-failure outcomes also carry the summary so the inbox can
     * surface what went wrong; the upload-job remains in `committed`
     * because the strict-status invariant means we cannot transition
     * back to a non-terminal state from `ready_for_review` after a
     * Confirm transition.
     */
    private static function partialSuccessMessage(WriteOutcome $outcome): ?string
    {
        if ($outcome->isClean()) {
            return null;
        }
        if ($outcome instanceof IntakeWriteOutcome) {
            $summary = $outcome->partialFailureSummary();
            return $summary === '' ? null : $summary;
        }
        if ($outcome instanceof LabWriteOutcome) {
            return sprintf('partial: %d row(s) failed', $outcome->failures);
        }
        // Generic fallback for future writers; keeps the prefix stable
        // for downstream filters even when the specific failure shape
        // is unknown to this caller.
        return 'partial: write failures recorded';
    }

    /**
     * Whole-document reject: stamp provenance with `rejected` and
     * transition the upload-job to `rejected`. No FHIR / `lists`
     * writes occur.
     *
     * @throws UploadJobNotReadyForReviewException
     */
    public function reject(string $jobUuid, int $userId): void
    {
        $job = $this->loadAndAssertReadyForReview($jobUuid);
        $extraction = $this->loadExtractionOrThrow($job);

        $this->sidecar->stampReview(
            $extraction->extractionId,
            $userId,
            SidecarPersister::REVIEW_DECISION_REJECTED,
            null,
        );

        $this->jobs->applyTransition(
            $jobUuid,
            UploadJobStatus::ReadyForReview,
            UploadJobTransition::Reject,
            $this->statusMachine,
        );
    }

    /**
     * @throws UploadJobNotReadyForReviewException when the job is
     *         missing or not in `ready_for_review`.
     */
    private function loadAndAssertReadyForReview(string $jobUuid): UploadJobRow
    {
        $job = $this->jobs->loadJob($jobUuid);
        if ($job === null) {
            // No row → treat as "not ready for review with the
            // failed sentinel" so the HTTP layer 409s on a stale uuid
            // rather than 500ing on a null.
            throw new UploadJobNotReadyForReviewException($jobUuid, UploadJobStatus::Failed);
        }
        if ($job->status !== UploadJobStatus::ReadyForReview) {
            throw new UploadJobNotReadyForReviewException($jobUuid, $job->status);
        }
        return $job;
    }

    /**
     * @throws \RuntimeException when the upload-job points at a
     *         document_id that has no matching sidecar row. This is a
     *         data-consistency error (extraction succeeded → sidecar
     *         must exist), not a recoverable runtime case.
     */
    private function loadExtractionOrThrow(UploadJobRow $job): ExtractionRow
    {
        $extraction = $this->sidecar->loadByDocumentId($job->documentId);
        if ($extraction === null) {
            throw new \RuntimeException(sprintf(
                'sidecar row missing for document_id %d (upload-job %s)',
                $job->documentId,
                $job->jobUuid,
            ));
        }
        return $extraction;
    }

    private function resolveWriter(string $docType): DocumentWriter
    {
        if (!isset($this->writersByDocType[$docType])) {
            throw new UnknownDocTypeException($docType);
        }
        return $this->writersByDocType[$docType];
    }
}
