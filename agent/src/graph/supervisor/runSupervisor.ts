/**
 * runSupervisor — chat-route-facing entry point. Builds the per-turn
 * availability hint, kicks the compiled supervisor graph, and returns
 * the verified answer along with metadata callers (chat route, tests)
 * need to log and stream.
 *
 * Hands off all transitive PHI exposure to the issue-12 PhiSet
 * established at the chat-route preHandler — this module does not
 * reach into AsyncLocalStorage; the traceable wrappers in the graph
 * nodes do that for us.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

import type { Answer } from '../../schemas/AnswerSchema.js';
import { buildAvailabilityHint, type AvailabilityHintDeps } from './availabilityHint.js';
import { createSupervisorGraph, type SupervisorGraphDeps } from './supervisorGraph.js';
import type { AccumulatedHandoff } from './types.js';

export interface RunSupervisorInput {
  readonly question: string;
  readonly pid: number;
  readonly conversationId: string;
}

export interface RunSupervisorResult {
  readonly answer: Answer;
  readonly droppedClaims: number;
  readonly handoffs: readonly AccumulatedHandoff[];
}

export interface RunSupervisorDeps extends SupervisorGraphDeps, AvailabilityHintDeps {}

export async function runSupervisor(
  input: RunSupervisorInput,
  deps: RunSupervisorDeps,
): Promise<RunSupervisorResult> {
  const hint = await buildAvailabilityHint(input.pid, deps);
  const graph = createSupervisorGraph(deps);

  const result = await graph.invoke({
    question: input.question,
    pid: input.pid,
    availabilityHint: hint,
  });

  const finalAnswer = result.finalAnswer ?? {
    summary: 'Supervisor produced no final answer.',
    claims: [{
      text: 'No final answer was produced this turn.',
      citation_ids: ['rule:no-data:supervisor'],
      severity: 'info' as const,
    }],
    conflicts: [],
    data_gaps: [],
    assumptions: [],
    evidence_catalog: [],
    followup_suggestions: [],
    confidence: 'low' as const,
  };

  return {
    answer: finalAnswer,
    droppedClaims: result.droppedClaims ?? 0,
    handoffs: result.accumulated ?? [],
  };
}
