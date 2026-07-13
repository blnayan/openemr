<?php

/**
 * DocumentWriter — the contract every doc-type writer (LabFhirWriter,
 * IntakeWriter) implements so ConfirmCommitter can route by `doc_type`
 * without knowing which subsystem owns the write.
 *
 * Implementations:
 *   - LabFhirWriter (lab_pdf): writes procedure_order/report/result and
 *     emits agentforge_resource_links rows (the FHIR Observation
 *     round-trip path).
 *   - IntakeWriter (intake_form, issue 23): writes lists rows for
 *     medications + allergies and a pnotes row for chief concern.
 *
 * Implementations must be free of "what if I already wrote this?"
 * branching — ConfirmCommitter enforces the strict-status invariant
 * (the upload-job is in `ready_for_review`) before calling
 * writeThrough(), so a double-confirm is rejected at the controller
 * layer and never reaches the writer.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\AgentForge\Persistence;

interface DocumentWriter
{
    /**
     * Translate the (already-edited) extracted JSON into the doc-type's
     * canonical OpenEMR rows and emit one
     * `agentforge_resource_links` back-pointer per written record.
     *
     * `documentId` is the `documents.id` of the uploaded source PDF/PNG;
     * the writer stamps it on every chart row it creates so downstream
     * readers (the chat tools, future FHIR extensions) can attribute
     * each row back to the document it came from. Pass 0 to skip the
     * stamp (e.g. tests that have no real documents row).
     *
     * @param int                  $extractionId agentforge_document_extractions.id
     * @param int                  $patientId    OpenEMR patient pid
     * @param int                  $documentId   documents.id of the source upload
     * @param array<string, mixed> $extracted    decoded, reviewer-edited payload
     */
    public function writeThrough(int $extractionId, int $patientId, int $documentId, array $extracted): WriteOutcome;
}
