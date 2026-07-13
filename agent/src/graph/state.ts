/**
 * Graph state shape — passed between LangGraph nodes. Pure types here so
 * tests can construct partial states without importing the runtime.
 */

import type { Answer } from '../schemas/AnswerSchema.js';
import type { ToolResult, ToolCallSpec } from '../tools/types.js';

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  createdAt: Date;
  /**
   * Optional structured payload captured for assistant turns. When present
   * it carries the full SSE-event shape (claims, citations, sections,
   * suggestions, etc.) so the sidebar can replay an assistant turn with
   * the same fidelity as the live response. Stored as opaque JSON.
   */
  payload?: unknown;
}

export type RouteDecision = 'clinical' | 'meta' | 'out_of_scope';

export interface SseEvent {
  event: string;
  data: unknown;
}

export interface FormattedAnswer {
  summary: string;
  claims: Answer['claims'];
  followupSuggestions: string[];
  confidence: 'high' | 'medium' | 'low';
  footer?: string;
  claimsRemoved?: number;
}

export type ChatMode = 'previsit' | 'followup';

export interface AgentStateType {
  question: string;
  conversationId: string;
  patientUuid: string;
  pid: number;
  encounterId: number | null;
  jwt: string;
  mode: ChatMode;
  history: ConversationMessage[];
  routeDecision: RouteDecision;
  plannerAction: 'call_tools' | 'respond';
  toolCalls: ToolCallSpec[];
  toolResults: ToolResult[];
  validCitationIds: Set<string>;
  draftAnswer: Answer | null;
  verifyOutcome: 'pass' | 'reject';
  verifyCritique: string | null;
  retryCount: number;
  finalAnswer: FormattedAnswer | null;
  sseEvents: SseEvent[];
}
