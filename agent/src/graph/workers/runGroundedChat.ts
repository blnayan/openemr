/**
 * runGroundedChat — Tuesday-milestone vertical slice.
 *
 *   question
 *      → EvidenceRetrieverWorker.run    (retrieve top-N reranked chunks)
 *      → GuidelineSynthesizer.synthesize (LLM produces AnswerSchema JSON)
 *      → verifyGuidelineCitations       (substring-check every guideline quote)
 *      → Answer (or low-confidence refusal if every claim was dropped)
 *
 * This is intentionally not the full Pattern A supervisor (issue 11). It
 * is a single-worker path for the one question shape we want to ground
 * end-to-end this week.
 */

import type { Answer, Claim } from '../../schemas/AnswerSchema.js';
import type { Retriever } from '../../retrieval/types.js';
import type { LlmInvoker } from '../../llm/AgentLlmClient.js';
import { EvidenceRetrieverWorker } from './EvidenceRetrieverWorker.js';
import { GuidelineSynthesizer } from './GuidelineSynthesizer.js';
import { verifyGuidelineCitations } from '../../verification/guidelineVerifier.js';

export interface GroundedChatDeps {
  readonly retriever: Retriever;
  readonly llm: LlmInvoker;
}

export interface GroundedChatResult {
  readonly answer: Answer;
  readonly droppedClaims: number;
  readonly retrievedChunkIds: readonly string[];
}

export async function runGroundedChat(
  question: string,
  deps: GroundedChatDeps,
): Promise<GroundedChatResult> {
  const worker = new EvidenceRetrieverWorker(deps.retriever);
  const evidence = await worker.run({ question });

  const synth = new GuidelineSynthesizer(deps.llm);
  const draft = await synth.synthesize({ question, chunks: evidence.chunks });

  const verified = verifyGuidelineCitations(draft.claims, evidence.chunks);

  if (verified.kept.length === 0 && draft.claims.length > 0) {
    // Every claim was dropped by the substring verifier. Degrade to a
    // low-confidence refusal per W2_PRD §"Synthesis at the supervisor
    // level".
    const refusal: Answer = {
      summary:
        'I drafted an answer but could not verify any claim against the cited guideline text. ' +
        'Refusing rather than presenting unverified content.',
      claims: [
        {
          text: 'No guideline-grounded claim survived substring verification.',
          citation_ids: ['rule:no-data:guideline-verifier'],
          severity: 'info',
        },
      ],
      conflicts: [],
      data_gaps: [],
      assumptions: [],
      evidence_catalog: [],
      followup_suggestions: [],
      confidence: 'low',
    };
    return {
      answer: refusal,
      droppedClaims: verified.dropped.length,
      retrievedChunkIds: evidence.chunks.map(c => c.id),
    };
  }

  const keptClaims: Claim[] = verified.kept.map(c => c);
  const finalAnswer: Answer = {
    summary: draft.summary,
    claims: keptClaims,
    conflicts: draft.conflicts,
    data_gaps: draft.data_gaps,
    assumptions: draft.assumptions,
    evidence_catalog: draft.evidence_catalog,
    followup_suggestions: draft.followup_suggestions,
    confidence: verified.dropped.length > 0 ? lowerConfidence(draft.confidence) : draft.confidence,
  };

  return {
    answer: finalAnswer,
    droppedClaims: verified.dropped.length,
    retrievedChunkIds: evidence.chunks.map(c => c.id),
  };
}

function lowerConfidence(c: 'high' | 'medium' | 'low'): 'high' | 'medium' | 'low' {
  switch (c) {
    case 'high': return 'medium';
    case 'medium': return 'low';
    case 'low': return 'low';
  }
}
