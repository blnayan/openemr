/**
 * SupervisorRouter — wraps the LLM call that, every tick, decides
 * whether to dispatch another worker handoff or move to synthesis.
 *
 * The LLM sees:
 *   - the original question,
 *   - the availability hint (what's reachable: docs, corpora, FHIR),
 *   - the accumulated worker outputs so far,
 *   - the remaining handoff budget.
 *
 * It returns a structured JSON object matching `SupervisorDecision`.
 * Schema-mismatch on the first reply triggers a single retry with
 * the validation issues appended; a second failure forces synthesis
 * deterministically (we never block the graph on a flaky model).
 *
 * The router is a pure adapter — it does NOT call workers itself, it
 * just produces a decision. The LangGraph `routeAfterSupervisor`
 * conditional edge translates that decision into a graph transition.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

import { z } from 'zod';
import type { LlmInvoker, ChatMessage } from '../../llm/AgentLlmClient.js';
import type { AvailabilityHint } from './types.js';
import type {
  AccumulatedHandoff,
  SupervisorDecision,
  WorkerName,
} from './types.js';
import { renderHintForPrompt } from './availabilityHint.js';

const WorkerNameSchema = z.enum([
  'fhir_context',
  'intake_extractor',
  'lab_extractor',
  'evidence_retriever',
  'clinical_data',
  'conflict_detector',
]);

const DecisionSchema = z.discriminatedUnion('next_action', [
  z.object({
    next_action: z.literal('call_worker'),
    worker: WorkerNameSchema,
    reason: z.string().min(1).max(500),
  }),
  z.object({
    next_action: z.literal('call_workers'),
    workers: z.array(WorkerNameSchema).min(1).max(4),
    reason: z.string().min(1).max(500),
  }),
  z.object({
    next_action: z.literal('synthesize'),
    reason: z.string().min(1).max(500),
  }),
]);

const PARALLELIZABLE_WORKERS: readonly WorkerName[] = [
  'intake_extractor',
  'lab_extractor',
  'evidence_retriever',
  'clinical_data',
];

export interface RouterInput {
  readonly question: string;
  readonly hint: AvailabilityHint;
  readonly accumulated: readonly AccumulatedHandoff[];
  readonly handoffsRemaining: number;
}

export class SupervisorRouter {
  constructor(private readonly llm: LlmInvoker) {}

  async decide(input: RouterInput): Promise<SupervisorDecision> {
    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildPrompt(input) },
    ];
    const first = await this.llm.chat(messages);
    const firstParse = tryParse(first.content);
    if (firstParse.ok) return validateDecision(firstParse.decision, input);

    const retry = await this.llm.chat([
      ...messages,
      { role: 'assistant', content: first.content },
      {
        role: 'user',
        content:
          'Your previous reply did not parse. Validation issues:\n'
          + `${firstParse.issues}\n\nReply again with corrected JSON only — `
          + 'no prose, no code fences.',
      },
    ]);
    const secondParse = tryParse(retry.content);
    if (secondParse.ok) return validateDecision(secondParse.decision, input);

    // Fail closed: force synthesis with whatever we have rather than
    // blocking the graph on a flaky model.
    return {
      next_action: 'synthesize',
      reason: `router_parse_failed: ${secondParse.issues.slice(0, 200)}`,
    };
  }
}

interface ParseOk { readonly ok: true; readonly decision: SupervisorDecision }
interface ParseFail { readonly ok: false; readonly issues: string }

function tryParse(raw: string): ParseOk | ParseFail {
  const stripped = stripJsonFences(raw).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    return {
      ok: false,
      issues: `JSON.parse failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const result = DecisionSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues
        .map(i => `- ${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('\n'),
    };
  }
  return { ok: true, decision: result.data };
}

function stripJsonFences(s: string): string {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced && fenced[1]) return fenced[1];
  return s;
}

/**
 * Don't let the supervisor loop forever on the same worker. If the
 * decision asks for a worker that has already been called this turn
 * we force synthesis. Additionally, after lab_extractor produces a
 * non-empty payload, deterministically chain clinical_data so the
 * synthesizer has tool:get_recent_labs:row-N rows alongside the lab
 * PDF document blob — every PDF result is persisted to procedure_result
 * by LabFhirWriter, so the chart row IS the canonical citation surface
 * and "recent labs #N" must be the primary pill (with doc:lab-<id> as
 * supplementary attribution).
 */
function validateDecision(
  decision: SupervisorDecision,
  input: RouterInput,
): SupervisorDecision {
  const calledAlready = (w: WorkerName): boolean =>
    input.accumulated.some(h => h.worker === w);

  let normalizedDecision: SupervisorDecision = decision;
  if (decision.next_action === 'call_worker' && calledAlready(decision.worker)) {
    normalizedDecision = {
      next_action: 'synthesize',
      reason: `worker_${decision.worker}_already_called; forcing synthesis to avoid loops`,
    };
  } else if (decision.next_action === 'call_workers') {
    const unique = [...new Set(decision.workers)];
    const filtered = unique.filter((w) =>
      PARALLELIZABLE_WORKERS.includes(w) && !calledAlready(w));
    if (filtered.length === 0) {
      return {
        next_action: 'synthesize',
        reason:
          'parallel_worker_set_empty_after_validation; forcing synthesis to avoid loops',
      };
    }
    normalizedDecision = {
      next_action: 'call_workers',
      workers: filtered,
      reason: decision.reason,
    };
  }

  const labRan = input.accumulated.some(
    h => h.worker === 'lab_extractor'
      && h.output.worker === 'lab_extractor'
      && h.output.labPdf !== null,
  );
  const clinicalRan = calledAlready('clinical_data');
  const fhirRan = calledAlready('fhir_context');
  const conflictRan = calledAlready('conflict_detector');
  if (!fhirRan && input.handoffsRemaining > 0) {
    return {
      next_action: 'call_worker',
      worker: 'fhir_context',
      reason:
        'fhir_context has not run yet; capturing compact chart context before deeper routing.',
    };
  }
  if (labRan && !clinicalRan && input.handoffsRemaining > 0) {
    return {
      next_action: 'call_worker',
      worker: 'clinical_data',
      reason:
        'lab_extractor returned a payload; chaining clinical_data so the '
        + 'synthesizer can cite the persisted procedure_result rows '
        + '(tool:get_recent_labs:row-N) as the primary pill.',
    };
  }

  const shouldRunConflictDetector = !conflictRan && (
    calledAlready('clinical_data')
    || (calledAlready('lab_extractor') && calledAlready('intake_extractor'))
  );
  if (shouldRunConflictDetector && input.handoffsRemaining > 0) {
    return {
      next_action: 'call_worker',
      worker: 'conflict_detector',
      reason: 'core evidence workers ran; detect cross-source conflicts before synthesis.',
    };
  }

  return normalizedDecision;
}

const SYSTEM_PROMPT = `You are AgentForge's supervisor. You orchestrate seven
workers to answer a doctor's question:

  - fhir_context: returns a compact chart snapshot (problem/med/lab/
    vitals/allergy counts + anchors). Run early for safe routing.

  - intake_extractor: returns the patient's latest intake-form sidecar
    (self-reported demographics, current_medications, allergies, family
    history, chief_concern). Call this when the question references the
    patient's reported history that may differ from the chart.
  - lab_extractor: returns the patient's latest uploaded lab PDF
    extraction (results array with display_value, units, reference range,
    abnormal_flag, plus bbox coords for the document viewer). Call this
    when the question references a recently-uploaded lab report by name
    or asks about the source document a value came from. When you call
    lab_extractor, you SHOULD also call clinical_data: lab values from
    the PDF are persisted to procedure_result with a document_id, so the
    same rows appear in get_recent_labs and the synthesizer needs both
    surfaces — the tool:get_recent_labs:row-N citation is the primary
    pill, and doc:lab-<id> supplements it as source attribution. Prefer
    clinical_data alone for general "recent labs" questions about the
    chart.
  - evidence_retriever: returns top-5 ranked guideline chunks from the
    indexed corpora. Call this when the question is about clinical
    guidelines or recommended targets/management.
  - clinical_data: runs the full Week-1 chart fan-out (problems, meds,
    labs, vitals, allergies, encounters, drug interactions). Call this
    when the question is about what is currently in the chart.
  - conflict_detector: checks accumulated outputs for source conflicts
    (chart vs uploaded docs, missing context mismatches). Prefer before synthesis.
Routing rules:
  - You MAY call multiple workers in sequence; each call uses one of your
    handoff budget slots (max 6 total).
  - You SHOULD NOT call the same worker twice — you already have its
    output.
  - fhir_context should run early (typically first).
  - When the assembled evidence is enough to answer the question
    (or when handoff_budget_remaining is 0), choose next_action="synthesize".
  - Reactive: choose only the workers the question actually needs. Do
    not call evidence_retriever for chart-state questions. Do not call
    clinical_data for pure guideline-lookup questions.
  - For questions like "what changed and what should I pay attention to",
    you typically want: fhir_context → intake/evidence/clinical →
    conflict_detector.

Reply format: a single JSON object, one of
  {"next_action": "call_worker", "worker": "<name>", "reason": "<reason>"}
  {"next_action": "call_workers", "workers": ["<name1>", "<name2>"], "reason": "<reason>"}
  {"next_action": "synthesize", "reason": "<reason>"}

Reply with JSON only — no prose, no code fences.`;

function buildPrompt(input: RouterInput): string {
  const lines: string[] = [];
  lines.push(`Question: ${input.question}`);
  lines.push('');
  lines.push('availability_hint:');
  lines.push(renderHintForPrompt(input.hint));
  lines.push('');
  lines.push(`handoff_budget_remaining: ${input.handoffsRemaining}`);
  lines.push('');
  lines.push('workers_called_so_far:');
  if (input.accumulated.length === 0) {
    lines.push('  (none)');
  } else {
    for (const h of input.accumulated) {
      lines.push(`  - ${h.worker} → ${summarizeOutput(h)}`);
    }
  }
  return lines.join('\n');
}

function summarizeOutput(h: AccumulatedHandoff): string {
  switch (h.output.worker) {
    case 'fhir_context':
      return `fhir snapshot (meds=${h.output.snapshot.activeMedsCount}, labs=${h.output.snapshot.recentLabsCount})`;
    case 'intake_extractor':
      return h.output.intakeForm === null
        ? 'no sidecar row available'
        : `intake_form extracted (extraction_id=${h.output.extractionId})`;
    case 'lab_extractor':
      return h.output.labPdf === null
        ? 'no sidecar row available'
        : `lab_pdf extracted with ${h.output.labPdf.results.length} result(s) `
          + `(extraction_id=${h.output.extractionId})`;
    case 'evidence_retriever':
      return `${h.output.chunks.length} guideline chunks retrieved`;
    case 'clinical_data':
      return `Week-1 answer with ${h.output.answer.claims.length} claims, `
        + `${h.output.toolResults.length} tool transcripts`;
    case 'conflict_detector':
      return `${h.output.conflicts.length} conflict item(s)`;
  }
}
