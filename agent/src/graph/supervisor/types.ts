/**
 * Supervisor types — shared type aliases and DTOs for the Pattern A
 * supervisor graph (issue 11). Kept in a single file so the worker
 * modules can refer to one another without circular imports.
 *
 * Design notes:
 *   - All shapes are `readonly` because state flows through several
 *     LangGraph nodes and mutating accumulator arrays in flight is
 *     a bug magnet.
 *   - `WorkerName` is a closed string-literal union so the supervisor's
 *     conditional-edge router and the synthesizer prompt builder agree
 *     on the same vocabulary statically.
 *   - The verifier reasons over a discriminated `WorkerOutput` rather
 *     than `unknown`, so a typo in the supervisor LLM's worker name
 *     surfaces at compile time.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

import type { IntakeForm } from '../../schemas/IntakeFormSchema.js';
import type { LabPdf } from '../../schemas/LabPdfSchema.js';
import type { RankedChunk } from '../../retrieval/types.js';
import type { Answer } from '../../schemas/AnswerSchema.js';
import type { ToolResult } from '../../tools/types.js';

/** Closed set of worker identifiers the supervisor may dispatch to. */
export type WorkerName =
  | 'fhir_context'
  | 'intake_extractor'
  | 'lab_extractor'
  | 'evidence_retriever'
  | 'clinical_data'
  | 'conflict_detector';

/**
 * Hard cap on the number of supervisor → worker handoffs in a single
 * turn. The supervisor is forced to synthesize once this is reached
 * even if it would prefer another worker call. PRD §"Routing".
 */
export const HANDOFF_CAP = 6;

/**
 * Availability hint surfaced to the supervisor at turn start. PRD
 * §"Routing": the supervisor sees what's reachable before it decides
 * which worker to call.
 */
export interface AvailabilityHint {
  readonly patientDocuments: readonly PatientDocumentSummary[];
  readonly guidelineCorpora: readonly GuidelineCorpusSummary[];
  readonly clinicalDataReachable: boolean;
}

export interface PatientDocumentSummary {
  readonly extraction_id: string;
  readonly doc_type: 'lab_pdf' | 'intake_form';
  readonly patient_match_status: 'verified' | 'unverifiable' | 'mismatch';
  readonly created_at: string;
}

export interface GuidelineCorpusSummary {
  readonly source: string;
  readonly version: string;
  readonly chunk_count: number;
}

/**
 * Discriminated union of worker outputs. The verifier and synthesizer
 * narrow on `worker` to know exactly which payload shape to expect.
 */
export type WorkerOutput =
  | FhirContextOutput
  | IntakeExtractorOutput
  | LabExtractorOutput
  | EvidenceRetrieverOutput
  | ClinicalDataOutput
  | ConflictDetectorOutput;

export interface FhirContextOutput {
  readonly worker: 'fhir_context';
  readonly snapshot: FhirContextSnapshot;
}

export interface FhirContextSnapshot {
  readonly hasPatientSummary: boolean;
  readonly activeProblemsCount: number;
  readonly activeMedsCount: number;
  readonly recentLabsCount: number;
  readonly recentVitalsCount: number;
  readonly allergiesCount: number;
  readonly recentEncountersCount: number;
  readonly anchors: readonly string[];
}

export interface IntakeExtractorOutput {
  readonly worker: 'intake_extractor';
  /** The latest intake-form sidecar payload, or null if no row exists. */
  readonly intakeForm: IntakeForm | null;
  readonly extractionId: string | null;
  /**
   * OpenEMR `documents.id` for the source PDF. Surfaced so chip labels
   * can render `Intake · <document_name> (#<documentId>)` instead of
   * mistaking the sidecar `extraction_id` for a `documents.id`.
   */
  readonly documentId: number | null;
  readonly documentName: string | null;
}

export interface LabExtractorOutput {
  readonly worker: 'lab_extractor';
  /** The latest lab_pdf sidecar payload, or null if no row exists. */
  readonly labPdf: LabPdf | null;
  readonly extractionId: string | null;
  /** See {@see IntakeExtractorOutput.documentId}. */
  readonly documentId: number | null;
  readonly documentName: string | null;
}

export interface EvidenceRetrieverOutput {
  readonly worker: 'evidence_retriever';
  readonly chunks: readonly RankedChunk[];
}

export interface ClinicalDataOutput {
  readonly worker: 'clinical_data';
  readonly answer: Answer;
  readonly toolResults: readonly ToolResult[];
}

export interface ConflictItem {
  readonly type:
    | 'medication_mismatch'
    | 'allergy_medication_risk'
    | 'lab_value_mismatch'
    | 'temporal_mismatch'
    | 'source_disagreement'
    | 'missing_context';
  readonly severity: 'info' | 'attention' | 'urgent';
  readonly message: string;
  readonly evidence_refs: readonly string[];
}

export interface ConflictDetectorOutput {
  readonly worker: 'conflict_detector';
  readonly conflicts: readonly ConflictItem[];
}

/** A single supervisor → worker → supervisor handoff record. */
export interface AccumulatedHandoff {
  readonly worker: WorkerName;
  readonly output: WorkerOutput;
  readonly latency_ms: number;
}

/**
 * Decision returned by the supervisor LLM at every tick. The graph
 * routes on `next_action` and (when calling a worker) on `worker`.
 */
export type SupervisorDecision =
  | { readonly next_action: 'call_worker'; readonly worker: WorkerName; readonly reason: string }
  | { readonly next_action: 'call_workers'; readonly workers: readonly WorkerName[]; readonly reason: string }
  | { readonly next_action: 'synthesize'; readonly reason: string };

/**
 * Sidecar reader used by the IntakeExtractorWorker. The interface is
 * narrow on purpose — the worker only needs the latest sidecar row
 * for a (pid, doc_type) pair. Production wires this up over an HTTP
 * client (`SidecarHttpClient`); tests stub it directly.
 */
export interface SidecarReader {
  /**
   * @returns The latest sidecar row's parsed `extracted_json` (already
   *          schema-validated upstream by the extractor pipeline) plus
   *          its row id, or null if the patient has no row of that
   *          doc_type yet.
   */
  readLatest(input: { readonly pid: number; readonly docType: 'lab_pdf' | 'intake_form' }):
    Promise<
      {
        readonly extractionId: string;
        readonly extractedJson: unknown;
        /** OpenEMR `documents.id` for the source PDF; null if the row hasn't been linked. */
        readonly documentId: number | null;
        /** `documents.name` for the source PDF; null if missing. */
        readonly documentName: string | null;
      } | null
    >;
}

/**
 * Clinical-data dispatch — wraps the Week-1 graph behind a single
 * call so the supervisor doesn't replicate planner/tools/verifier
 * logic. Returns the Week-1 `Answer` and the underlying tool transcript
 * so the supervisor verifier can resolve `patient_record` citations.
 */
export interface ClinicalDataDispatcher {
  run(input: { readonly question: string; readonly pid: number }):
    Promise<{ readonly answer: Answer; readonly toolResults: readonly ToolResult[] }>;
}

export interface FhirContextDispatcher {
  /**
   * Returns a compact, retrieval-safe snapshot of chart context that the
   * supervisor can use for route decisions and conflict checks.
   */
  run(input: { readonly question: string; readonly pid: number }): Promise<FhirContextSnapshot>;
}
