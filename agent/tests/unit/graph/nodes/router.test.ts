/**
 * Router node unit tests
 *
 * The router classifies questions into clinical | meta | out_of_scope.
 * Out-of-scope classification short-circuits to formatter with no tool calls.
 *
 * Uses a fake LLMClient for deterministic routing.
 *
 * Plan reference: §5.3 router.test.ts, M2/M3, ARCHITECTURE.md "router node"
 * UC-1: "Tell me about James Lee while Maria's chart is open" → out_of_scope
 */

import { describe, it, expect, vi } from 'vitest';
import { runRouter, type RouteDecision } from '../../../../src/graph/nodes/router.js';
import type { AgentStateType } from '../../../../src/graph/state.js';

function fakeLlm(decision: RouteDecision) {
  return {
    invoke: vi.fn().mockResolvedValue({ content: decision }),
  };
}

function baseState(question: string): Partial<AgentStateType> {
  return {
    question,
    patientUuid: 'jwt-patient-uuid',
    pid: 42,
    encounterId: 17,
    jwt: 'test-jwt',
    history: [],
    routeDecision: undefined as unknown as RouteDecision,
  };
}

describe('router node', () => {
  // §5.3: "Tell me about James Lee" → out_of_scope
  // UC-1: cross-patient question → refuse; no tool calls
  it('classifies "tell me about James Lee" as out_of_scope', async () => {
    const llm = fakeLlm('out_of_scope');
    const state = baseState('Tell me about James Lee') as AgentStateType;

    const result = await runRouter(state, llm as unknown as Parameters<typeof runRouter>[1]);

    expect(result.routeDecision).toBe('out_of_scope');
  });

  // §5.3: "What are her labs?" → clinical
  it('classifies clinical lab question as clinical', async () => {
    const llm = fakeLlm('clinical');
    const state = baseState("What are her labs?") as AgentStateType;

    const result = await runRouter(state, llm as unknown as Parameters<typeof runRouter>[1]);

    expect(result.routeDecision).toBe('clinical');
  });

  // §5.3: "How do I configure you?" → meta
  it('classifies meta question as meta', async () => {
    const llm = fakeLlm('meta');
    const state = baseState('How do I configure you?') as AgentStateType;

    const result = await runRouter(state, llm as unknown as Parameters<typeof runRouter>[1]);

    expect(result.routeDecision).toBe('meta');
  });

  it('returns state with routeDecision populated', async () => {
    const llm    = fakeLlm('clinical');
    const state  = baseState("What's her A1c?") as AgentStateType;
    const result = await runRouter(state, llm as unknown as Parameters<typeof runRouter>[1]);

    expect(result.routeDecision).toBeDefined();
    expect(['clinical', 'meta', 'out_of_scope']).toContain(result.routeDecision);
  });

  it('calls the LLM exactly once per routing decision', async () => {
    const llm   = fakeLlm('clinical');
    const state = baseState("Is the new statin OK?") as AgentStateType;

    await runRouter(state, llm as unknown as Parameters<typeof runRouter>[1]);

    expect(llm.invoke).toHaveBeenCalledTimes(1);
  });

  // LLM router uses gpt-5-mini per ARCHITECTURE.md
  it('provides the question as part of the LLM prompt', async () => {
    const question = 'What changed since last visit?';
    const llm      = fakeLlm('clinical');
    const state    = baseState(question) as AgentStateType;

    await runRouter(state, llm as unknown as Parameters<typeof runRouter>[1]);

    const callArgs = JSON.stringify(llm.invoke.mock.calls[0]);
    expect(callArgs).toContain(question);
  });

  // §4.1: out_of_scope short-circuit (graph edge condition)
  it('writes only routeDecision — does not modify tool-related state fields', async () => {
    const llm = fakeLlm('out_of_scope');
    const state = {
      ...baseState('Tell me about James Lee'),
    } as AgentStateType;

    const result = await runRouter(state, llm as unknown as Parameters<typeof runRouter>[1]);

    // Router must not populate tool-related fields — those are the planner's domain
    expect(result.toolCalls).toBeUndefined();
    expect(result.toolResults).toBeUndefined();
  });
});
