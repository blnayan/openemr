/**
 * Tools node — dispatches the planner's ToolCallSpec list in parallel.
 * Builds the validCitationIds set for Layer 1 to consume.
 */

import { TOOL_REGISTRY } from '../../tools/index.js';
import type { ToolContext, ToolResult } from '../../tools/types.js';
import type { AgentStateType } from '../state.js';

export async function runTools(
  state: AgentStateType,
  context: ToolContext,
): Promise<Partial<AgentStateType>> {
  const calls = state.toolCalls ?? [];
  const ranInThisIteration = await Promise.all(calls.map(async spec => {
    const fn = TOOL_REGISTRY[spec.toolName];
    if (!fn) {
      return { ok: false, reason: 'unknown_tool', tool: spec.toolName } satisfies ToolResult;
    }
    try {
      return await fn(spec.params, context);
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : 'tool_threw',
        tool: spec.toolName,
      } satisfies ToolResult;
    }
  }));

  const merged = mergeResults(state.toolResults ?? [], ranInThisIteration);

  const validCitationIds = new Set<string>();
  for (const r of merged) {
    if (!r.ok) continue;
    for (const row of r.rows) {
      if (typeof row.id === 'string') validCitationIds.add(row.id);
    }
  }

  return {
    toolResults: merged,
    validCitationIds,
    toolCalls: [],
  };
}

function mergeResults(prior: ToolResult[], next: ToolResult[]): ToolResult[] {
  const out: ToolResult[] = [...prior];
  for (const result of next) {
    const idx = out.findIndex(r => r.tool === result.tool);
    if (idx >= 0) out[idx] = result;
    else out.push(result);
  }
  return out;
}
