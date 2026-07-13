/**
 * Router node — classifies the question into clinical / meta /
 * out_of_scope. Out-of-scope short-circuits straight to the formatter.
 */

import type { AgentStateType } from '../state.js';

export type RouteDecision = 'clinical' | 'meta' | 'out_of_scope';

export interface RouterLlmClient {
  invoke(input: unknown): Promise<{ content: string }>;
}

const SYSTEM_PROMPT =
  'You classify clinician questions about a single patient into one of three classes: ' +
  '"clinical" (about the patient on screen), "meta" (about the assistant itself), or ' +
  '"out_of_scope" (about a different patient, administrative/billing/scheduling, or anything ' +
  'outside the visible chart). Reply with ONLY the class name.';

export async function runRouter(
  state: AgentStateType,
  llmClient: RouterLlmClient,
): Promise<Partial<AgentStateType>> {
  const prompt = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Question: ${state.question}\nClass:` },
  ];

  const response = await llmClient.invoke(prompt);
  const raw = response.content.trim().toLowerCase().replace(/[^a-z_]/g, '');

  let decision: RouteDecision = 'clinical';
  if (raw === 'out_of_scope') decision = 'out_of_scope';
  else if (raw === 'meta') decision = 'meta';
  else if (raw === 'clinical') decision = 'clinical';

  return { routeDecision: decision };
}
