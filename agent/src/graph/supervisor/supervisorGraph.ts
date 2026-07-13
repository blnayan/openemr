/**
 * supervisorGraph — the LangGraph.js state graph that wires the
 * supervisor + three workers + synthesizer + verifier into a single
 * inspectable orchestration tree.
 *
 * Topology:
 *
 *     START → supervisor
 *               ├─→ fhir_context       → supervisor (loop edge)
 *               ├─→ parallel_workers   → supervisor (loop edge)
 *               │      ├─ intake_extractor
 *               │      ├─ lab_extractor
 *               │      ├─ evidence_retriever
 *               │      └─ clinical_data
 *               ├─→ conflict_detector  → supervisor (loop edge)
 *               └─→ synthesize → verify → END
 *
 * Each worker node and the supervisor router itself runs inside
 * `tracedTraceable`, so every handoff surfaces as a Langfuse child
 * run with the worker name, args, output summary, and latency. The
 * per-request PhiSet flows in via AsyncLocalStorage (issue 12).
 *
 * The state tracks an append-only `accumulated` array and a monotonic
 * `handoffCount`. The supervisor router is told the remaining budget
 * each tick; when it runs out the conditional edge forces synthesis.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import { tracedTraceable } from '../../observability/index.js';
import { routeQuestion } from '../workers/routeQuestion.js';
import type { Answer } from '../../schemas/AnswerSchema.js';
import type { FhirContextWorker } from './FhirContextWorker.js';
import type { IntakeExtractorWorker } from './IntakeExtractorWorker.js';
import type { LabExtractorWorker } from './LabExtractorWorker.js';
import type { EvidenceRetrieverWorker } from '../workers/EvidenceRetrieverWorker.js';
import type { ClinicalDataWorker } from './ClinicalDataWorker.js';
import type { ConflictDetectorWorker } from './ConflictDetectorWorker.js';
import type { SupervisorRouter } from './SupervisorRouter.js';
import type { SupervisorSynthesizer } from './Synthesizer.js';
import type { SupervisorVerifier } from './Verifier.js';
import {
  HANDOFF_CAP,
  type AvailabilityHint,
  type AccumulatedHandoff,
  type WorkerName,
} from './types.js';

// ---------------------------------------------------------------------------
// State schema
// ---------------------------------------------------------------------------

const SupervisorAnnotation = Annotation.Root({
  question: Annotation<string>(),
  pid: Annotation<number>(),
  availabilityHint: Annotation<AvailabilityHint>(),
  accumulated: Annotation<AccumulatedHandoff[]>({
    reducer: (left, right) => [...left, ...right],
    default: () => [],
  }),
  handoffCount: Annotation<number>({
    reducer: (_, right) => right,
    default: () => 0,
  }),
  /** Set by the supervisor node each tick to drive the conditional edge. */
  nextRoute: Annotation<WorkerName | 'parallel_workers' | 'synthesize'>({
    reducer: (_, right) => right,
    default: () => 'synthesize',
  }),
  /**
   * Worker set to fan out in parallel when nextRoute='parallel_workers'.
   */
  parallelWorkers: Annotation<WorkerName[]>({
    reducer: (_, right) => right,
    default: () => [],
  }),
  forcedSynthesis: Annotation<boolean>({
    reducer: (_, right) => right,
    default: () => false,
  }),
  draftAnswer: Annotation<Answer | null>({
    reducer: (_, right) => right,
    default: () => null,
  }),
  finalAnswer: Annotation<Answer | null>({
    reducer: (_, right) => right,
    default: () => null,
  }),
  droppedClaims: Annotation<number>({
    reducer: (_, right) => right,
    default: () => 0,
  }),
  /**
   * Last completed graph node. Used for deterministic fast-path transitions
   * that avoid unnecessary router LLM round-trips.
   */
  lastCompletedNode: Annotation<
    | 'supervisor'
    | WorkerName
    | 'parallel_workers'
    | 'synthesize'
    | 'verify'
    | null
  >({
    reducer: (_, right) => right,
    default: () => null,
  }),
});

export type SupervisorState = typeof SupervisorAnnotation.State;

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface SupervisorGraphDeps {
  readonly router: SupervisorRouter;
  readonly fhirContext: FhirContextWorker;
  readonly intakeExtractor: IntakeExtractorWorker;
  readonly labExtractor: LabExtractorWorker;
  readonly evidenceRetriever: EvidenceRetrieverWorker;
  readonly clinicalData: ClinicalDataWorker;
  readonly conflictDetector: ConflictDetectorWorker;
  readonly synthesizer: SupervisorSynthesizer;
  readonly verifier: SupervisorVerifier;
}

// ---------------------------------------------------------------------------
// Graph factory
// ---------------------------------------------------------------------------

export function createSupervisorGraph(deps: SupervisorGraphDeps): ReturnType<
  ReturnType<typeof buildBuilder>['compile']
> {
  return buildBuilder(deps).compile();
}

function buildBuilder(deps: SupervisorGraphDeps): StateGraph<typeof SupervisorAnnotation.spec> {
  const supervisorNode = wrapTraced(
    'supervisor.route',
    async (state: SupervisorState) => {
      // Hard cap: when we've spent the budget, force synthesis without
      // calling the LLM again. This is the safety valve called for in
      // the acceptance criteria.
      if (state.handoffCount >= HANDOFF_CAP) {
        return {
          nextRoute: 'synthesize' as const,
          forcedSynthesis: true,
          lastCompletedNode: 'supervisor' as const,
        };
      }

      // Deterministic fast-paths: once a parallel worker bundle has completed,
      // route directly to conflict detection; once conflicts are computed, move
      // directly to synthesis. This avoids extra router LLM ticks where the
      // next step is deterministic from graph state.
      if (state.lastCompletedNode === 'parallel_workers') {
        return {
          nextRoute: 'conflict_detector' as const,
          forcedSynthesis: false,
          lastCompletedNode: 'supervisor' as const,
        };
      }
      if (state.lastCompletedNode === 'conflict_detector') {
        return {
          nextRoute: 'synthesize' as const,
          forcedSynthesis: false,
          lastCompletedNode: 'supervisor' as const,
        };
      }

      // Initial-tick fast-path: when the availability hint shows the
      // question can only be answered by the clinical-data worker (no
      // patient documents to extract from, no guideline corpus relevant
      // to the question), there is nothing for the router LLM to decide.
      // Bundle clinical_data deterministically and skip the ~4s router
      // round-trip. Non-trivial hints still go through the LLM router.
      const initialBundle = pickInitialBundle(state);
      if (initialBundle !== null) {
        return {
          nextRoute: 'parallel_workers' as const,
          parallelWorkers: initialBundle,
          forcedSynthesis: false,
          lastCompletedNode: 'supervisor' as const,
        };
      }

      const decision = await deps.router.decide({
        question: state.question,
        hint: state.availabilityHint,
        accumulated: state.accumulated,
        handoffsRemaining: HANDOFF_CAP - state.handoffCount,
      });

      if (decision.next_action === 'synthesize') {
        return {
          nextRoute: 'synthesize' as const,
          forcedSynthesis: false,
          lastCompletedNode: 'supervisor' as const,
        };
      }
      if (decision.next_action === 'call_workers') {
        return {
          nextRoute: 'parallel_workers' as const,
          parallelWorkers: [...decision.workers],
          forcedSynthesis: false,
          lastCompletedNode: 'supervisor' as const,
        };
      }
      return {
        nextRoute: decision.worker,
        forcedSynthesis: false,
        lastCompletedNode: 'supervisor' as const,
      };
    },
  );

  const intakeNode = wrapTraced(
    'worker.intake_extractor',
    async (state: SupervisorState) => {
      const t0 = Date.now();
      const output = await deps.intakeExtractor.run({ pid: state.pid });
      return {
        accumulated: [{
          worker: 'intake_extractor' as const,
          output,
          latency_ms: Date.now() - t0,
        }],
        handoffCount: state.handoffCount + 1,
        lastCompletedNode: 'intake_extractor' as const,
      };
    },
  );

  const fhirNode = wrapTraced(
    'worker.fhir_context',
    async (state: SupervisorState) => {
      const t0 = Date.now();
      const output = await deps.fhirContext.run({
        question: state.question,
        pid: state.pid,
      });
      return {
        accumulated: [{
          worker: 'fhir_context' as const,
          output,
          latency_ms: Date.now() - t0,
        }],
        handoffCount: state.handoffCount + 1,
        lastCompletedNode: 'fhir_context' as const,
      };
    },
  );

  const labNode = wrapTraced(
    'worker.lab_extractor',
    async (state: SupervisorState) => {
      const t0 = Date.now();
      const output = await deps.labExtractor.run({ pid: state.pid });
      return {
        accumulated: [{
          worker: 'lab_extractor' as const,
          output,
          latency_ms: Date.now() - t0,
        }],
        handoffCount: state.handoffCount + 1,
        lastCompletedNode: 'lab_extractor' as const,
      };
    },
  );

  const evidenceNode = wrapTraced(
    'worker.evidence_retriever',
    async (state: SupervisorState) => {
      const t0 = Date.now();
      const result = await deps.evidenceRetriever.run({ question: state.question });
      return {
        accumulated: [{
          worker: 'evidence_retriever' as const,
          output: { worker: 'evidence_retriever' as const, chunks: result.chunks },
          latency_ms: Date.now() - t0,
        }],
        handoffCount: state.handoffCount + 1,
        lastCompletedNode: 'evidence_retriever' as const,
      };
    },
  );

  const clinicalNode = wrapTraced(
    'worker.clinical_data',
    async (state: SupervisorState) => {
      const t0 = Date.now();
      const output = await deps.clinicalData.run({
        question: state.question,
        pid: state.pid,
      });
      return {
        accumulated: [{
          worker: 'clinical_data' as const,
          output,
          latency_ms: Date.now() - t0,
        }],
        handoffCount: state.handoffCount + 1,
        lastCompletedNode: 'clinical_data' as const,
      };
    },
  );

  const conflictNode = wrapTraced(
    'worker.conflict_detector',
    async (state: SupervisorState) => {
      const t0 = Date.now();
      const output = deps.conflictDetector.run({
        accumulated: state.accumulated,
      });
      return {
        accumulated: [{
          worker: 'conflict_detector' as const,
          output,
          latency_ms: Date.now() - t0,
        }],
        handoffCount: state.handoffCount + 1,
        lastCompletedNode: 'conflict_detector' as const,
      };
    },
  );

  const parallelWorkersNode = wrapTraced(
    'worker.parallel_bundle',
    async (state: SupervisorState) => {
      const budgetRemaining = Math.max(0, HANDOFF_CAP - state.handoffCount);
      const selected = state.parallelWorkers.slice(0, budgetRemaining);
      if (selected.length === 0) {
        return {
          parallelWorkers: [] as WorkerName[],
          lastCompletedNode: 'parallel_workers' as const,
        };
      }

      const handoffs = await Promise.all(
        selected.map((worker) => runTracedWorkerByName(worker, state, deps)),
      );

      return {
        accumulated: handoffs,
        handoffCount: state.handoffCount + handoffs.length,
        parallelWorkers: [] as WorkerName[],
        lastCompletedNode: 'parallel_workers' as const,
      };
    },
  );

  const synthesizeNode = wrapTraced(
    'supervisor.synthesize',
    async (state: SupervisorState) => {
      const draft = await deps.synthesizer.synthesize({
        question: state.question,
        accumulated: state.accumulated,
        forcedSynthesis: state.forcedSynthesis,
      });
      // eslint-disable-next-line no-console
      console.log('[agentforge.supervisor.synthesize] draft', JSON.stringify({
        confidence: draft.confidence,
        claimCount: draft.claims.length,
        claims: draft.claims.map(c => ({
          text: c.text.slice(0, 100),
          citation_ids: c.citation_ids,
          citations: c.citations?.map(cit => {
            if (cit.type === 'guideline') return { type: 'guideline', chunk_id: cit.chunk_id, section_id: cit.section_id };
            if (cit.type === 'patient_document') return { type: 'patient_document', extraction_id: cit.extraction_id };
            return { type: cit.type, citation_id: cit.citation_id };
          }) ?? [],
        })),
      }));
      return { draftAnswer: draft, lastCompletedNode: 'synthesize' as const };
    },
  );

  const verifyNode = wrapTraced(
    'supervisor.verify',
    async (state: SupervisorState) => {
      if (state.draftAnswer === null) {
        // Should not happen, but degrade safely.
        return {
          finalAnswer: lowConfidenceFallback('Synthesizer produced no draft answer.'),
          droppedClaims: 0,
          lastCompletedNode: 'verify' as const,
        };
      }
      const verified = await deps.verifier.verify(
        state.draftAnswer,
        state.accumulated,
        state.pid,
      );
      return {
        finalAnswer: verified.answer,
        droppedClaims: verified.droppedClaims,
        lastCompletedNode: 'verify' as const,
      };
    },
  );

  // The state graph is parameterized by the annotation; addNode is
  // where the typed node functions get registered.
  const builder = new StateGraph(SupervisorAnnotation)
    .addNode('supervisor', supervisorNode)
    .addNode('fhir_context', fhirNode)
    .addNode('intake_extractor', intakeNode)
    .addNode('lab_extractor', labNode)
    .addNode('evidence_retriever', evidenceNode)
    .addNode('clinical_data', clinicalNode)
    .addNode('parallel_workers', parallelWorkersNode)
    .addNode('conflict_detector', conflictNode)
    .addNode('synthesize', synthesizeNode)
    .addNode('verify', verifyNode)
    .addEdge(START, 'supervisor')
    .addConditionalEdges(
      'supervisor',
      (state: SupervisorState) => state.nextRoute,
      {
        fhir_context: 'fhir_context',
        intake_extractor: 'intake_extractor',
        lab_extractor: 'lab_extractor',
        evidence_retriever: 'evidence_retriever',
        clinical_data: 'clinical_data',
        parallel_workers: 'parallel_workers',
        conflict_detector: 'conflict_detector',
        synthesize: 'synthesize',
      },
    )
    .addEdge('fhir_context', 'supervisor')
    .addEdge('intake_extractor', 'supervisor')
    .addEdge('lab_extractor', 'supervisor')
    .addEdge('evidence_retriever', 'supervisor')
    .addEdge('clinical_data', 'supervisor')
    .addEdge('parallel_workers', 'supervisor')
    .addEdge('conflict_detector', 'supervisor')
    .addEdge('synthesize', 'verify')
    .addEdge('verify', END);

  // The cast is needed because the chained-builder generics on
  // StateGraph don't narrow when we round-trip through `buildBuilder`'s
  // declared return type. The runtime object is the same.
  return builder as unknown as StateGraph<typeof SupervisorAnnotation.spec>;
}

/**
 * Decide whether the very first supervisor tick can skip the router
 * LLM entirely. Returns a deterministic worker bundle for trivial
 * cases, or null when the LLM needs to weigh options.
 *
 * "Trivial" means the only signal source available is the chart:
 *   - no patient documents (no intake_form / lab_pdf to extract),
 *   - no relevant guideline corpus (either none registered, or the
 *     question is not guideline-shaped per the deterministic regex),
 *   - the FHIR side is reachable (otherwise we would just produce a
 *     refusal — that decision is left to the LLM router for now).
 *
 * Restricting the fast-path to handoffCount=0 / lastCompletedNode=null
 * keeps the LLM router in the loop for any tick where prior worker
 * output might change the routing decision.
 */
function pickInitialBundle(state: SupervisorState): WorkerName[] | null {
  if (state.handoffCount !== 0 || state.lastCompletedNode !== null) return null;

  const hint = state.availabilityHint;
  if (!hint.clinicalDataReachable) return null;
  if (hint.patientDocuments.length > 0) return null;

  const isGuidelineShaped = routeQuestion(state.question) === 'guideline';
  if (isGuidelineShaped && hint.guidelineCorpora.length > 0) return null;

  return ['clinical_data'];
}

async function runWorkerByName(
  worker: WorkerName,
  state: SupervisorState,
  deps: SupervisorGraphDeps,
): Promise<AccumulatedHandoff> {
  const t0 = Date.now();
  switch (worker) {
    case 'fhir_context': {
      const output = await deps.fhirContext.run({
        question: state.question,
        pid: state.pid,
      });
      return { worker, output, latency_ms: Date.now() - t0 };
    }
    case 'intake_extractor': {
      const output = await deps.intakeExtractor.run({ pid: state.pid });
      return { worker, output, latency_ms: Date.now() - t0 };
    }
    case 'lab_extractor': {
      const output = await deps.labExtractor.run({ pid: state.pid });
      return { worker, output, latency_ms: Date.now() - t0 };
    }
    case 'evidence_retriever': {
      const result = await deps.evidenceRetriever.run({ question: state.question });
      return {
        worker,
        output: { worker: 'evidence_retriever', chunks: result.chunks },
        latency_ms: Date.now() - t0,
      };
    }
    case 'clinical_data': {
      const output = await deps.clinicalData.run({
        question: state.question,
        pid: state.pid,
      });
      return { worker, output, latency_ms: Date.now() - t0 };
    }
    case 'conflict_detector': {
      const output = deps.conflictDetector.run({
        accumulated: state.accumulated,
      });
      return { worker, output, latency_ms: Date.now() - t0 };
    }
  }
}

async function runTracedWorkerByName(
  worker: WorkerName,
  state: SupervisorState,
  deps: SupervisorGraphDeps,
): Promise<AccumulatedHandoff> {
  const wrapped = tracedTraceable(
    async () => runWorkerByName(worker, state, deps),
    {
      name: `worker.${worker}`,
      processInputs: () => ({
        worker,
        question: state.question,
        handoff_count: state.handoffCount,
        accumulated_count: state.accumulated.length,
      }),
      processOutputs: (outputs) => {
        const out = outputs['output'];
        if (!out || typeof out !== 'object') return outputs;
        const handoff = out as Partial<AccumulatedHandoff> & { output?: { worker?: string } };
        return {
          worker,
          output_worker: handoff.output?.worker,
          latency_ms: handoff.latency_ms,
        };
      },
    },
  ) as unknown as () => Promise<AccumulatedHandoff>;
  return wrapped();
}

/**
 * Wrap a node action with tracedTraceable so each invocation produces
 * a Langfuse child run with the supplied name. The wrapper is
 * cheap — when Langfuse credentials are unset the wrapper short-circuits
 * to the underlying function.
 */
function wrapTraced<TArgs extends unknown[], TRet>(
  runName: string,
  fn: (...args: TArgs) => Promise<TRet>,
): (...args: TArgs) => Promise<TRet> {
  return tracedTraceable(
    fn as unknown as (...a: never[]) => unknown,
    {
      name: runName,
      processInputs: summarizeNodeInputs,
      processOutputs: summarizeNodeOutputs,
    },
  ) as unknown as (...args: TArgs) => Promise<TRet>;
}

function summarizeNodeInputs(inputs: Record<string, unknown>): Record<string, unknown> {
  const args = Array.isArray(inputs['args']) ? inputs['args'] : [];
  const state = (args[0] ?? {}) as Partial<SupervisorState>;
  return {
    question: typeof state.question === 'string' ? state.question : undefined,
    handoff_count: typeof state.handoffCount === 'number' ? state.handoffCount : undefined,
    accumulated_count: Array.isArray(state.accumulated) ? state.accumulated.length : undefined,
    next_route: typeof state.nextRoute === 'string' ? state.nextRoute : undefined,
  };
}

function summarizeNodeOutputs(outputs: Record<string, unknown>): Record<string, unknown> {
  const out = outputs['output'];
  if (!out || typeof out !== 'object') return outputs;
  const typed = out as Record<string, unknown>;
  return {
    accumulated_count: Array.isArray(typed['accumulated']) ? typed['accumulated'].length : undefined,
    handoff_count: typeof typed['handoffCount'] === 'number' ? typed['handoffCount'] : undefined,
    next_route: typeof typed['nextRoute'] === 'string' ? typed['nextRoute'] : undefined,
    parallel_workers: Array.isArray(typed['parallelWorkers'])
      ? typed['parallelWorkers']
      : undefined,
    dropped_claims: typeof typed['droppedClaims'] === 'number'
      ? typed['droppedClaims']
      : undefined,
    last_completed_node: typeof typed['lastCompletedNode'] === 'string'
      ? typed['lastCompletedNode']
      : undefined,
  };
}

function lowConfidenceFallback(reason: string): Answer {
  return {
    summary: `Unable to produce an answer: ${reason}`,
    claims: [{
      text: 'Supervisor synthesis did not complete.',
      citation_ids: ['rule:no-data:supervisor'],
      severity: 'info',
    }],
    conflicts: [],
    data_gaps: [],
    assumptions: [],
    evidence_catalog: [],
    followup_suggestions: [],
    confidence: 'low',
  };
}
