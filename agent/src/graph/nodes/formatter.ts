/**
 * Formatter — converts the verified Answer into the SSE event sequence
 * sent back to the browser. Urgent rule claims are bumped to the top.
 */

import type { AgentStateType, FormattedAnswer, SseEvent } from '../state.js';
import type { Answer } from '../../schemas/AnswerSchema.js';

const REFUSAL_TEXT =
  'I can only answer questions about the patient currently on screen. ' +
  'Please open the right chart and ask again.';

export function runFormatter(state: AgentStateType): Partial<AgentStateType> {
  if (state.routeDecision === 'out_of_scope') {
    return {
      finalAnswer: {
        summary: REFUSAL_TEXT,
        claims: [],
        followupSuggestions: [],
        confidence: 'high',
      },
      sseEvents: [
        { event: 'summary', data: { text: REFUSAL_TEXT } },
        { event: 'done', data: {} },
      ],
    };
  }

  const draft = state.draftAnswer;
  if (!draft) {
    return {
      finalAnswer: null,
      sseEvents: [
        { event: 'error', data: { reason: 'no_answer' } },
        { event: 'done', data: {} },
      ],
    };
  }

  const claims = downgradePlannerUrgent(draft.claims);
  const sortedClaims = [...claims].sort((a, b) => severityRank(b.severity) - severityRank(a.severity));

  const formatted: FormattedAnswer = {
    summary: draft.summary,
    claims: sortedClaims,
    followupSuggestions: draft.followup_suggestions,
    confidence: draft.confidence,
  };

  if (state.verifyCritique === 'partial_after_retries') {
    formatted.footer =
      'Some claims were removed — could not verify against this turn\'s data. Retry or open the chart.';
  }

  const sseEvents: SseEvent[] = [];
  sseEvents.push({ event: 'conversation', data: { conversation_id: state.conversationId } });
  sseEvents.push({ event: 'summary', data: { text: formatted.summary } });

  for (const claim of formatted.claims) {
    sseEvents.push({
      event: 'claim',
      data: {
        text: claim.text,
        citation_ids: claim.citation_ids,
        severity: claim.severity,
      },
    });
  }

  for (const suggestion of formatted.followupSuggestions) {
    sseEvents.push({ event: 'suggestion', data: { text: suggestion } });
  }

  if (formatted.footer) {
    sseEvents.push({ event: 'footer', data: { text: formatted.footer } });
  }

  sseEvents.push({ event: 'done', data: {} });

  return { finalAnswer: formatted, sseEvents };
}

function severityRank(s: 'info' | 'attention' | 'urgent'): number {
  if (s === 'urgent') return 2;
  if (s === 'attention') return 1;
  return 0;
}

function downgradePlannerUrgent(claims: Answer['claims']): Answer['claims'] {
  return claims.map(c => {
    const isRule = c.citation_ids.every(cid => cid.startsWith('rule:'));
    if (c.severity === 'urgent' && !isRule) {
      return { ...c, severity: 'attention' as const };
    }
    return c;
  });
}
