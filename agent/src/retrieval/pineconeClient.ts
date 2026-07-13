/**
 * Thin wrapper around the Pinecone Node SDK.
 *
 * The retrieval pipeline never imports `@pinecone-database/pinecone`
 * directly. It accepts a `PineconeClient` interface, and tests inject
 * a stub. In production a `RealPineconeClient` is built via
 * `createRealPineconeClient(...)` from a real `Pinecone` instance.
 *
 * The integrated-index API is used (Pinecone embeds server-side):
 * upsertRecords / searchRecords pass raw text in the field named in
 * the index's `fieldMap` (here: `text`). No client-side embedding.
 *
 * Reranking is delegated to `inference.rerank` with the configured
 * model. A configurable fallback model is invoked if the primary
 * rerank model fails (e.g. invalid model slug, transient server-side
 * error).
 */

import type { Pinecone } from '@pinecone-database/pinecone';
import type { Chunk, RankedChunk } from './types.js';

/** A single dense-search hit from Pinecone (post integrated embed). */
export interface DenseHit {
  readonly id: string;
  readonly score: number;
}

export interface PineconeClient {
  /** Create the index for the configured embedding model if missing. */
  ensureIndex(name: string, embedModel: string): Promise<void>;
  /** Upsert chunks (integrated index path; text embedded server-side). */
  upsertChunks(name: string, namespace: string, chunks: readonly Chunk[]): Promise<void>;
  /** Run a dense (text -> server-side embed) search. */
  denseSearch(name: string, namespace: string, query: string, topK: number): Promise<readonly DenseHit[]>;
  /**
   * Rerank documents against the query. Returns the input items
   * reordered by descending rerank score, with each item's score
   * attached. The order of `chunks` in the input does not matter.
   */
  rerank(
    primaryModel: string,
    fallbackModel: string,
    query: string,
    chunks: readonly Chunk[],
    topN: number,
  ): Promise<readonly RankedChunk[]>;
}

/** The integrated-index field that holds the chunk body (matches `fieldMap`). */
export const TEXT_FIELD = 'text';

interface RawHit {
  readonly _id?: string;
  readonly _score?: number;
}

interface RawSearchResult {
  readonly result?: {
    readonly hits?: ReadonlyArray<RawHit>;
  };
}

interface RawRerankResult {
  readonly data?: ReadonlyArray<{
    readonly index: number;
    readonly score: number;
  }>;
}

/**
 * Build a `PineconeClient` backed by a real `Pinecone` SDK instance.
 * Constructed via factory rather than `new` so unit tests can inject
 * a stub of the same interface.
 */
export function createRealPineconeClient(pinecone: Pinecone, cloud: string, region: string): PineconeClient {
  return {
    async ensureIndex(name: string, embedModel: string): Promise<void> {
      try {
        await pinecone.describeIndex(name);
        return;
      } catch {
        // fall through and create.
      }
      await pinecone.createIndexForModel({
        name,
        cloud,
        region,
        embed: {
          model: embedModel,
          fieldMap: { text: TEXT_FIELD },
        },
        waitUntilReady: true,
        suppressConflicts: true,
      });
    },

    async upsertChunks(name: string, namespace: string, chunks: readonly Chunk[]): Promise<void> {
      const index = pinecone.index(name);
      const ns = index.namespace(namespace);
      // Integrated records: id + the field map's text field, plus any
      // metadata keys we want filterable later. No `metadata` envelope.
      const records = chunks.map(c => ({
        _id: c.id,
        [TEXT_FIELD]: c.body,
        source: c.source,
        section_id: c.section_id,
        page: c.page,
        // Optional fields — included only when present so the index
        // schema stays consistent and Pinecone does not reject the
        // record. Empty string instead of null because Pinecone
        // integrated indexes do not accept null-typed metadata.
        grade: c.grade ?? '',
        source_url: c.source_url ?? '',
      }));
      // Pinecone caps upsertRecords at 96 per call.
      for (let i = 0; i < records.length; i += 96) {
        const batch = records.slice(i, i + 96);
        await ns.upsertRecords({ records: batch });
      }
    },

    async denseSearch(name: string, namespace: string, query: string, topK: number): Promise<readonly DenseHit[]> {
      const index = pinecone.index(name);
      const ns = index.namespace(namespace);
      const raw = await ns.searchRecords({
        query: { topK, inputs: { text: query } },
        fields: ['source', 'section_id', 'page'],
      }) as RawSearchResult;
      const hits = raw.result?.hits ?? [];
      return hits
        .filter((h): h is RawHit & { _id: string; _score: number } =>
          typeof h._id === 'string' && typeof h._score === 'number')
        .map(h => ({ id: h._id, score: h._score }));
    },

    async rerank(
      primaryModel: string,
      fallbackModel: string,
      query: string,
      chunks: readonly Chunk[],
      topN: number,
    ): Promise<readonly RankedChunk[]> {
      if (chunks.length === 0) return [];
      const docs = chunks.map(c => ({ id: c.id, [TEXT_FIELD]: c.body }));

      const callRerank = async (model: string): Promise<RawRerankResult> =>
        await pinecone.inference.rerank({
          model,
          query,
          documents: docs,
          topN,
          rankFields: [TEXT_FIELD],
          returnDocuments: false,
        }) as RawRerankResult;

      let result: RawRerankResult;
      try {
        result = await callRerank(primaryModel);
      } catch (err) {
        if (primaryModel === fallbackModel) throw err;
        result = await callRerank(fallbackModel);
      }
      const ordered = (result.data ?? []).filter(d =>
        typeof d.index === 'number' && typeof d.score === 'number');
      return ordered.flatMap<RankedChunk>(d => {
        const chunk = chunks[d.index];
        if (!chunk) return [];
        return [{
          id: chunk.id,
          source: chunk.source,
          section_id: chunk.section_id,
          page: chunk.page,
          body: chunk.body,
          score: d.score,
        }];
      });
    },
  };
}
