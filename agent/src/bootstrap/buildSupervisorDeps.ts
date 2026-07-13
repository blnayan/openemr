/**
 * buildSupervisorDeps — per-request assembly of `RunSupervisorDeps`.
 *
 * The chat route calls this once per follow-up turn when the
 * server-wide LLM + retriever pair is wired. It bolts the per-request
 * pieces — JWT-bound SidecarHttpClient, ClinicalDataDispatcher
 * adapter wrapping `runFollowup`, the corpus registry, and a cheap
 * reachability probe — onto the long-lived deps so the supervisor
 * graph can run with live evidence retrieval, live intake-form
 * lookup, and the existing Week-1 chart fan-out as the clinical-data
 * worker.
 *
 * Why per-request: the SidecarHttpClient carries the inbound scoped
 * JWT, so it must not be a server-wide singleton. The other supervisor
 * pieces (router/synthesizer/verifier) are pure adapters over the LLM
 * and are cheap to construct each turn.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

import type { LlmInvoker } from '../llm/AgentLlmClient.js';
import type { Retriever } from '../retrieval/types.js';
import type { ToolContext } from '../tools/types.js';
import type { CachedTranscript } from '../db/ConversationCache.js';
import type { ConversationMessage } from '../graph/state.js';
import { runFollowup } from '../graph/runFollowup.js';
import { EvidenceRetrieverWorker } from '../graph/workers/EvidenceRetrieverWorker.js';
import {
  FhirContextWorker,
  IntakeExtractorWorker,
  LabExtractorWorker,
  ClinicalDataWorker,
  ConflictDetectorWorker,
  SidecarHttpClient,
  StaticGuidelineCorpusRegistry,
  SupervisorRouter,
  SupervisorSynthesizer,
  SupervisorVerifier,
  type RunSupervisorDeps,
  type SidecarReader,
  type ClinicalDataDispatcher,
  type FhirContextDispatcher,
} from '../graph/supervisor/index.js';
import type {
  ClinicalDataReachabilityProbe,
  GuidelineCorpusRegistry,
} from '../graph/supervisor/availabilityHint.js';
import type { GuidelineCorpusSummary } from '../graph/supervisor/types.js';

export interface SupervisorRequestContext {
  /** Inbound scoped JWT (Authorization: Bearer …). */
  readonly chatJwt: string;
  /** OpenEMR base URL — `https://host` (no path). */
  readonly openemrBaseUrl: string;
  readonly tlsInsecure: boolean;
  readonly toolContext: ToolContext;
  readonly cached: CachedTranscript;
  readonly priorMessages: readonly ConversationMessage[];
}

export interface BuildSupervisorDepsArgs {
  readonly llm: LlmInvoker;
  /** Optional separate LLM for the synthesizer (e.g. Sonnet for stricter
   * instruction-following) — falls back to `llm` when unset. */
  readonly synthesizerLlm?: LlmInvoker;
  readonly retriever: Retriever;
  readonly request: SupervisorRequestContext;
  readonly corpora: readonly GuidelineCorpusSummary[];
}

/**
 * Construct a fully-wired RunSupervisorDeps for a single chat turn.
 * The clinical-data dispatcher reuses the Week-1 `runFollowup` path
 * so its planner / verifier / refusal-router guards continue to fire
 * exactly as they did pre-supervisor.
 */
export function buildSupervisorDeps(args: BuildSupervisorDepsArgs): RunSupervisorDeps {
  const sidecar = new SidecarHttpClient({
    baseUrl: args.request.openemrBaseUrl,
    jwt: args.request.chatJwt,
    tlsInsecure: args.request.tlsInsecure,
  });
  const sidecarReader: SidecarReader = sidecar;

  const intakeExtractor = new IntakeExtractorWorker(sidecarReader);
  const labExtractor = new LabExtractorWorker(sidecarReader);
  const evidenceRetriever = new EvidenceRetrieverWorker(args.retriever);
  const conflictDetector = new ConflictDetectorWorker();

  const fhirContextDispatcher: FhirContextDispatcher = {
    async run() {
      const tools = args.request.cached.toolResults;
      const countRows = (tool: string): number => {
        const r = tools.find(t => t.tool === tool && t.ok);
        return r && r.ok ? r.rows.length : 0;
      };
      const anchors: string[] = [];
      const summary = tools.find(t => t.tool === 'get_patient_summary' && t.ok);
      if (summary && summary.ok && summary.rows.length > 0) {
        const row = summary.rows[0];
        const given = typeof row?.['given_name'] === 'string' ? row['given_name'] : null;
        const family = typeof row?.['family_name'] === 'string' ? row['family_name'] : null;
        if (given || family) anchors.push([given, family].filter(Boolean).join(' '));
      }
      return {
        hasPatientSummary: Boolean(summary && summary.ok && summary.rows.length > 0),
        activeProblemsCount: countRows('get_active_problems'),
        activeMedsCount: countRows('get_medications'),
        recentLabsCount: countRows('get_recent_labs'),
        recentVitalsCount: countRows('get_vitals'),
        allergiesCount: countRows('get_allergies'),
        recentEncountersCount: countRows('get_recent_encounters'),
        anchors,
      };
    },
  };
  const fhirContext = new FhirContextWorker(fhirContextDispatcher);

  const dispatcher: ClinicalDataDispatcher = {
    async run({ question }) {
      const result = await runFollowup(
        question,
        args.request.cached,
        args.request.toolContext,
        args.llm,
        args.request.priorMessages.slice(),
      );
      return { answer: result.answer, toolResults: result.toolResults };
    },
  };
  const clinicalData = new ClinicalDataWorker(dispatcher);

  const router = new SupervisorRouter(args.llm);
  const synthesizer = new SupervisorSynthesizer(args.synthesizerLlm ?? args.llm);
  const verifier = new SupervisorVerifier({ patientDocumentVerifier: sidecar });

  const corpusRegistry: GuidelineCorpusRegistry =
    new StaticGuidelineCorpusRegistry(args.corpora);

  const clinicalDataProbe: ClinicalDataReachabilityProbe = {
    async isReachable() {
      // Cheap heuristic — if we already have a cached pre-visit
      // transcript for this turn, the FHIR side has been reached at
      // least once this conversation.
      return args.request.cached.toolResults.length > 0;
    },
  };

  return {
    router,
    fhirContext,
    intakeExtractor,
    labExtractor,
    evidenceRetriever,
    clinicalData,
    conflictDetector,
    synthesizer,
    verifier,
    sidecarSummaryReader: sidecar,
    clinicalDataProbe,
    corpusRegistry,
  };
}
