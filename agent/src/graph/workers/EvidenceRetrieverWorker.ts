/**
 * EvidenceRetrieverWorker — the W2_PRD evidence-retriever worker.
 *
 * Pure adapter over the hybrid retriever in `src/retrieval`. The worker
 * exists so the supervisor (Pattern A, issue 11) can call it as a
 * uniformly-shaped node alongside the intake-extractor and clinical-data
 * workers, instead of every node ad-hoc importing the retriever.
 *
 * Today (issue 06) it has one consumer: the chat route's "guideline-
 * shaped question" branch, which calls `run({ question })` and feeds
 * the ranked chunks straight into the GuidelineSynthesizer.
 *
 * Constructor-injected retriever — tests stub at the `Retriever`
 * interface boundary, never at module import.
 */

import type { RankedChunk, Retriever } from '../../retrieval/types.js';

export interface EvidenceRetrieverInput {
  readonly question: string;
}

export interface EvidenceRetrieverOutput {
  readonly chunks: readonly RankedChunk[];
}

export class EvidenceRetrieverWorker {
  constructor(private readonly retriever: Retriever) {}

  async run(input: EvidenceRetrieverInput): Promise<EvidenceRetrieverOutput> {
    const question = input.question.trim();
    if (question.length === 0) {
      return { chunks: [] };
    }
    const chunks = await this.retriever.retrieve(question);
    return { chunks };
  }
}
