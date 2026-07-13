/**
 * availabilityHint — pure builder that gathers the structured "what's
 * reachable" snapshot the supervisor sees at turn start. PRD §"Routing":
 * the supervisor reads this before deciding which worker to call.
 *
 * Inputs are dependency-injected so the builder is fully unit-testable
 * without spinning up Pinecone, the FHIR client, or the OpenEMR DB.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

import type {
  AvailabilityHint,
  GuidelineCorpusSummary,
  PatientDocumentSummary,
} from './types.js';

/**
 * Lookup hook for patient sidecar metadata. Returns a list of summaries
 * (one per extraction row for the patient). Mirrors the `SidecarReader`
 * interface but is broader — it lists *all* rows, not just the latest.
 */
export interface SidecarSummaryReader {
  listForPatient(input: { readonly pid: number }):
    Promise<readonly PatientDocumentSummary[]>;
}

/**
 * Reachability probe for the FHIR side. The supervisor exposes the
 * boolean to the LLM so it can avoid dispatching to clinical-data
 * when the upstream is down. Implementations should do something
 * cheap (HEAD, capability statement, or just "do we have a JWT");
 * tests stub a static value.
 */
export interface ClinicalDataReachabilityProbe {
  isReachable(): Promise<boolean>;
}

/** Static registry of guideline corpora the retriever can search. */
export interface GuidelineCorpusRegistry {
  list(): readonly GuidelineCorpusSummary[];
}

export interface AvailabilityHintDeps {
  readonly sidecarSummaryReader: SidecarSummaryReader;
  readonly clinicalDataProbe: ClinicalDataReachabilityProbe;
  readonly corpusRegistry: GuidelineCorpusRegistry;
}

/**
 * Build the availability hint for a single chat turn. Failures from
 * either dep degrade the relevant section to "empty / unreachable"
 * rather than failing the whole request — the supervisor can still
 * try other workers.
 */
export async function buildAvailabilityHint(
  pid: number,
  deps: AvailabilityHintDeps,
): Promise<AvailabilityHint> {
  const [docs, reachable] = await Promise.all([
    safeListDocs(deps.sidecarSummaryReader, pid),
    safeProbe(deps.clinicalDataProbe),
  ]);
  return {
    patientDocuments: docs,
    guidelineCorpora: deps.corpusRegistry.list(),
    clinicalDataReachable: reachable,
  };
}

async function safeListDocs(
  reader: SidecarSummaryReader,
  pid: number,
): Promise<readonly PatientDocumentSummary[]> {
  try {
    return await reader.listForPatient({ pid });
  } catch {
    return [];
  }
}

async function safeProbe(probe: ClinicalDataReachabilityProbe): Promise<boolean> {
  try {
    return await probe.isReachable();
  } catch {
    return false;
  }
}

/**
 * Compact, JSON-stringifiable shape used to inline the hint into the
 * supervisor prompt. Keeping the renderer next to the builder makes
 * it obvious what the supervisor LLM sees vs. what's only metadata.
 */
export function renderHintForPrompt(hint: AvailabilityHint): string {
  const lines: string[] = [];
  lines.push(`patient_documents (${hint.patientDocuments.length}):`);
  if (hint.patientDocuments.length === 0) {
    lines.push('  (none)');
  } else {
    for (const d of hint.patientDocuments) {
      lines.push(
        `  - extraction_id=${d.extraction_id} doc_type=${d.doc_type} `
        + `match=${d.patient_match_status} created_at=${d.created_at}`,
      );
    }
  }
  lines.push(`guideline_corpora (${hint.guidelineCorpora.length}):`);
  for (const g of hint.guidelineCorpora) {
    lines.push(`  - ${g.source} v${g.version} (${g.chunk_count} chunks)`);
  }
  lines.push(`clinical_data_reachable: ${hint.clinicalDataReachable ? 'yes' : 'no'}`);
  return lines.join('\n');
}
