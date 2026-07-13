/**
 * Graph driver — sequential implementation of the LangGraph state
 * machine described in the implementation plan §2 M2/M3. Sequential
 * keeps the dependency surface small (no @langchain/langgraph runtime
 * required for the test suite) while preserving the same edge logic.
 */

import { runRouter, type RouterLlmClient } from './nodes/router.js';
import { runPlanner, type PlannerLlmClient } from './nodes/planner.js';
import { runTools } from './nodes/tools.js';
import { runVerifier, MAX_RETRIES } from './nodes/verifier.js';
import { runFormatter } from './nodes/formatter.js';
import type { AgentStateType } from './state.js';
import type { ToolContext } from '../tools/types.js';
import type { LlmJudgeClient } from '../verification/judge.js';

export interface GraphClients {
  router?: RouterLlmClient | null;
  planner?: PlannerLlmClient | null;
  judge?: LlmJudgeClient | null;
}

export async function runGraph(
  initialState: AgentStateType,
  toolContext: ToolContext,
  clients: GraphClients,
): Promise<AgentStateType> {
  let state: AgentStateType = { ...initialState };

  if (clients.router) {
    try {
      state = { ...state, ...(await runRouter(state, clients.router)) };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[agentforge] router LLM call failed, defaulting to clinical', {
        error: err instanceof Error ? err.message : String(err),
      });
      state.routeDecision = 'clinical';
    }
  } else {
    state.routeDecision = 'clinical';
  }

  if (state.routeDecision === 'out_of_scope') {
    state = { ...state, ...runFormatter(state) };
    return state;
  }

  let plannerLoops = 0;
  const HARD_LOOP_CAP = 6;

  while (plannerLoops < HARD_LOOP_CAP) {
    plannerLoops += 1;

    state = { ...state, ...(await runPlanner(state, clients.planner ?? null)) };

    if (state.plannerAction === 'call_tools') {
      state = { ...state, ...(await runTools(state, toolContext)) };
      continue;
    }

    state = { ...state, ...(await runVerifier(state, clients.judge ?? null)) };

    if (state.verifyOutcome === 'pass') break;
    if (state.retryCount >= MAX_RETRIES) break;
  }

  state = { ...state, ...runFormatter(state) };
  return state;
}

export function makeInitialState(opts: {
  question: string;
  conversationId: string;
  patientUuid: string;
  pid: number;
  encounterId: number | null;
  jwt: string;
  mode?: 'previsit' | 'followup';
}): AgentStateType {
  return {
    question: opts.question,
    conversationId: opts.conversationId,
    patientUuid: opts.patientUuid,
    pid: opts.pid,
    encounterId: opts.encounterId,
    jwt: opts.jwt,
    mode: opts.mode ?? 'followup',
    history: [],
    routeDecision: 'clinical',
    plannerAction: 'call_tools',
    toolCalls: [],
    toolResults: [],
    validCitationIds: new Set<string>(),
    draftAnswer: null,
    verifyOutcome: 'pass',
    verifyCritique: null,
    retryCount: 0,
    finalAnswer: null,
    sseEvents: [],
  };
}
