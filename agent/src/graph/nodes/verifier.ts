/**
 * Verifier node — Layer 2 (clinical rules) → Layer 1 (citation
 * grounding) → Layer 3 (LLM judge). Reject loops back to planner up to
 * 2 retries, after which the formatter emits a partial-answer footer.
 */

import { ClinicalRuleEngine } from '../../verification/ClinicalRuleEngine.js';
import { verifyLayer1 } from '../../verification/verifyLayer1.js';
import { runJudge, type LlmJudgeClient } from '../../verification/judge.js';
import type { AgentStateType } from '../state.js';
import type { Answer } from '../../schemas/AnswerSchema.js';

export const MAX_RETRIES = 2;

export async function runVerifier(
  state: AgentStateType,
  judgeClient: LlmJudgeClient | null,
): Promise<Partial<AgentStateType>> {
  const draft = state.draftAnswer;
  if (!draft) {
    return { verifyOutcome: 'pass', verifyCritique: null };
  }

  const engine = new ClinicalRuleEngine();
  const ruleFindings = engine.evaluate(state.toolResults);

  const enrichedClaims: Answer['claims'] = [
    ...draft.claims,
    ...ruleFindings.map(rule => ({
      text: rule.description,
      citation_ids: [rule.citationId],
      severity: rule.severity,
    })),
  ];

  const enrichedDraft: Answer = { ...draft, claims: enrichedClaims };

  const layer1 = verifyLayer1(enrichedDraft, state.validCitationIds);
  if (!layer1.pass) {
    if (state.retryCount < MAX_RETRIES) {
      return {
        verifyOutcome: 'reject',
        verifyCritique: layer1.critique,
        retryCount: state.retryCount + 1,
      };
    }
    const stripped = enrichedClaims.filter(c =>
      c.citation_ids.every(cid =>
        cid.startsWith('rule:') || cid.startsWith('doc:') || state.validCitationIds.has(cid),
      ),
    );
    return {
      verifyOutcome: 'pass',
      verifyCritique: layer1.critique,
      draftAnswer: { ...enrichedDraft, claims: stripped },
    };
  }

  if (judgeClient) {
    const verdict = await runJudge(state.toolResults, enrichedDraft, judgeClient);
    if (!verdict.pass && state.retryCount < MAX_RETRIES) {
      return {
        verifyOutcome: 'reject',
        verifyCritique: `Judge flagged: ${verdict.suspiciousClaims.join('; ')}`,
        retryCount: state.retryCount + 1,
      };
    }
    if (!verdict.pass) {
      const stripped = enrichedClaims.filter(c => !verdict.suspiciousClaims.includes(c.text));
      return {
        verifyOutcome: 'pass',
        draftAnswer: { ...enrichedDraft, claims: stripped },
        verifyCritique: 'partial_after_retries',
      };
    }
  }

  return { verifyOutcome: 'pass', draftAnswer: enrichedDraft, verifyCritique: null };
}
