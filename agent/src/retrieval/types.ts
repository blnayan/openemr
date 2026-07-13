/**
 * Public types for the AgentForge hybrid retrieval module.
 *
 * The retriever is a deep module: a single `retrieve(query)` entry
 * point fans out across dense (Pinecone Inference) and sparse (in-process
 * BM25), fuses the two ranked lists with reciprocal rank fusion, and
 * reranks the fused list with Pinecone Inference. Every type below is
 * `readonly` because retrieval results flow through several stages and
 * mutating them in flight is a bug magnet.
 */

/**
 * A single chunk of guideline text. Chunks are produced by the ingest
 * script (one chunk per numbered recommendation or named subsection)
 * and live in two places at runtime: Pinecone (dense) and the BM25
 * sidecar (sparse).
 */
export interface Chunk {
  readonly id: string;
  readonly source: string;
  readonly section_id: string;
  readonly page: number;
  readonly body: string;
  /**
   * ADA-style recommendation grade (`A`, `B`, `C`, `E`). Optional because
   * not every guideline source uses graded recommendations and not every
   * recommendation in a graded source carries a grade letter.
   */
  readonly grade?: 'A' | 'B' | 'C' | 'E';
  /**
   * Direct URL to the source chapter or section the chunk was extracted
   * from. Optional for backward compatibility with fixture corpora.
   */
  readonly source_url?: string;
}

/**
 * A chunk after retrieval, carrying its rerank score. Returned by
 * `retrieve(query)` in descending order of `score`.
 */
export interface RankedChunk {
  readonly id: string;
  readonly source: string;
  readonly section_id: string;
  readonly page: number;
  readonly body: string;
  readonly score: number;
  readonly grade?: 'A' | 'B' | 'C' | 'E';
  readonly source_url?: string;
}

/**
 * Configuration for a Retriever. All values come from env vars in
 * production; tests pass values directly. There are no default model
 * slugs that look like `latest` — every slug is pinned.
 */
export interface RetrievalConfig {
  readonly indexName: string;
  readonly embedModel: string;
  readonly rerankModel: string;
  readonly rerankFallbackModel: string;
  readonly namespace: string;
  /** How many candidates to take from each ranked list before RRF. */
  readonly fusionTopK: number;
  /** How many chunks to return from `retrieve(query)`. */
  readonly finalTopN: number;
  /** RRF rank smoothing constant. */
  readonly rrfK: number;
}

export const DEFAULT_RETRIEVAL_CONFIG: Omit<RetrievalConfig, 'indexName' | 'embedModel' | 'rerankModel' | 'rerankFallbackModel'> = {
  namespace: '__default__',
  fusionTopK: 20,
  finalTopN: 5,
  rrfK: 60,
};

export interface Retriever {
  retrieve(query: string): Promise<readonly RankedChunk[]>;
}
