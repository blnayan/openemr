/**
 * Hybrid retriever — orchestrates dense + sparse + RRF + rerank.
 *
 *   1. Dense:  PineconeClient.denseSearch(query, fusionTopK)
 *   2. Sparse: Bm25Index.search(query, fusionTopK)
 *   3. Fuse:   reciprocalRankFusion([dense, sparse], rrfK)
 *   4. Rerank: PineconeClient.rerank(query, fused chunks, finalTopN)
 *
 * The retriever holds the chunk corpus in memory (a Map keyed by
 * chunk id) so step (4) can rehydrate fused ids into full chunk
 * bodies for the reranker. This keeps Pinecone's payload smaller
 * (we don't ask it to ship bodies back on every search) and keeps
 * BM25 hits fully populated even when the dense pass skipped them.
 */

import { Bm25Index } from './bm25.js';
import type { PineconeClient } from './pineconeClient.js';
import { reciprocalRankFusion } from './rrf.js';
import type { Chunk, RankedChunk, RetrievalConfig, Retriever } from './types.js';

export interface RetrieverDeps {
  readonly pinecone: PineconeClient;
  readonly bm25: Bm25Index;
  readonly chunks: readonly Chunk[];
}

export function createRetriever(config: RetrievalConfig, deps: RetrieverDeps): Retriever {
  const byId = new Map<string, Chunk>();
  for (const c of deps.chunks) byId.set(c.id, c);

  return {
    async retrieve(query: string): Promise<readonly RankedChunk[]> {
      if (query.trim().length === 0) return [];

      const [denseHits, sparseHits] = await Promise.all([
        deps.pinecone.denseSearch(config.indexName, config.namespace, query, config.fusionTopK),
        Promise.resolve(deps.bm25.search(query, config.fusionTopK)),
      ]);

      const fused = reciprocalRankFusion([denseHits, sparseHits], config.rrfK);
      if (fused.length === 0) return [];

      // Rerank operates on at most fusionTopK candidates (already capped
      // by the inputs); rehydrate ids -> chunks.
      const candidates: Chunk[] = [];
      for (const f of fused) {
        const chunk = byId.get(f.id);
        if (chunk) candidates.push(chunk);
      }
      if (candidates.length === 0) return [];

      const reranked = await deps.pinecone.rerank(
        config.rerankModel,
        config.rerankFallbackModel,
        query,
        candidates,
        config.finalTopN,
      );
      return reranked;
    },
  };
}
