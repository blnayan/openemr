/**
 * Retriever unit tests. The Pinecone client is fully stubbed so no
 * network call is made; BM25 runs over a real fixture corpus. The
 * rerank step is the final source of truth — the test verifies that
 * the canned rerank output flows through unchanged.
 */

import { describe, expect, it, vi } from 'vitest';
import { Bm25Index } from '../../../src/retrieval/bm25.js';
import { createRetriever } from '../../../src/retrieval/retriever.js';
import type { PineconeClient, DenseHit } from '../../../src/retrieval/pineconeClient.js';
import type { Chunk, RankedChunk, RetrievalConfig } from '../../../src/retrieval/types.js';

const FIXTURE: readonly Chunk[] = [
  { id: 'doc1', source: 'fixture', section_id: '1', page: 1, body: 'Diabetes screening at age 35 for asymptomatic adults.' },
  { id: 'doc2', source: 'fixture', section_id: '2', page: 2, body: 'Hypertension target below 130/80 mmHg in diabetic patients.' },
  { id: 'doc3', source: 'fixture', section_id: '3', page: 3, body: 'A1c diagnostic threshold for diabetes is 6.5 percent.' },
  { id: 'doc4', source: 'fixture', section_id: '4', page: 4, body: 'Hypoglycemia level 1 glucose less than 70 mg per deciliter.' },
  { id: 'doc5', source: 'fixture', section_id: '5', page: 5, body: 'Glucagon prescribed for individuals at increased risk of hypoglycemia.' },
  { id: 'doc6', source: 'fixture', section_id: '6', page: 6, body: 'SGLT2 inhibitors recommended in type 2 diabetes with chronic kidney disease.' },
];

const CONFIG: RetrievalConfig = {
  indexName: 'test-index',
  embedModel: 'llama-text-embed-v2',
  rerankModel: 'cohere-rerank-3.5',
  rerankFallbackModel: 'bge-reranker-v2-m3',
  namespace: '__default__',
  fusionTopK: 5,
  finalTopN: 3,
  rrfK: 60,
};

function buildBm25(): Bm25Index {
  const idx = new Bm25Index();
  idx.add(FIXTURE);
  return idx;
}

function makeStubClient(opts: {
  dense: readonly DenseHit[];
  rerankOrder: readonly string[]; // ids in the order rerank should output
}): PineconeClient {
  return {
    ensureIndex: vi.fn(async () => {}),
    upsertChunks: vi.fn(async () => {}),
    denseSearch: vi.fn(async () => opts.dense),
    rerank: vi.fn(async (
      _primary: string,
      _fallback: string,
      _query: string,
      chunks: readonly Chunk[],
      topN: number,
    ): Promise<readonly RankedChunk[]> => {
      const byId = new Map(chunks.map(c => [c.id, c]));
      // Simulate rerank: output the requested order, skipping ids not
      // present in the candidate set, scoring descending from 1.0.
      const out: RankedChunk[] = [];
      let score = 1.0;
      for (const id of opts.rerankOrder) {
        const c = byId.get(id);
        if (!c) continue;
        out.push({
          id: c.id,
          source: c.source,
          section_id: c.section_id,
          page: c.page,
          body: c.body,
          score,
        });
        score -= 0.1;
        if (out.length >= topN) break;
      }
      return out;
    }),
  };
}

describe('createRetriever', () => {
  it('returns the canned rerank order, top-N truncated', async () => {
    const client = makeStubClient({
      dense: [
        { id: 'doc4', score: 0.9 },
        { id: 'doc5', score: 0.85 },
        { id: 'doc1', score: 0.7 },
      ],
      // canned rerank: doc5 first, then doc4, then doc1
      rerankOrder: ['doc5', 'doc4', 'doc1'],
    });
    const retriever = createRetriever(CONFIG, {
      pinecone: client,
      bm25: buildBm25(),
      chunks: FIXTURE,
    });

    const out = await retriever.retrieve('hypoglycemia glucose');
    expect(out).toHaveLength(3);
    expect(out.map(r => r.id)).toEqual(['doc5', 'doc4', 'doc1']);
    expect(out[0]!.score).toBeCloseTo(1.0, 6);
    expect(out[1]!.score).toBeCloseTo(0.9, 6);
    expect(out[2]!.score).toBeCloseTo(0.8, 6);
    // verify full RankedChunk shape carries source/section/page/body
    expect(out[0]).toMatchObject({
      id: 'doc5',
      source: 'fixture',
      section_id: '5',
      page: 5,
    });
    expect(out[0]!.body.length).toBeGreaterThan(0);
  });

  it('passes only the fused candidate set to the reranker', async () => {
    const client = makeStubClient({
      dense: [{ id: 'doc4', score: 0.9 }, { id: 'doc1', score: 0.5 }],
      rerankOrder: ['doc4', 'doc5', 'doc1'],
    });
    const retriever = createRetriever(CONFIG, {
      pinecone: client,
      bm25: buildBm25(),
      chunks: FIXTURE,
    });

    await retriever.retrieve('hypoglycemia');

    const rerankCall = (client.rerank as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    const candidatesPassed = rerankCall[3] as readonly Chunk[];
    // BM25 plus dense should both reach doc4 and doc5 (BM25 hits 'hypoglycemia');
    // doc1 came from the dense list. The reranker must only see fused candidates.
    const ids = candidatesPassed.map(c => c.id);
    expect(ids).toContain('doc4');
    expect(ids).toContain('doc5');
    expect(ids).toContain('doc1');
    expect(ids.length).toBeLessThanOrEqual(CONFIG.fusionTopK + CONFIG.fusionTopK);
  });

  it('returns empty for an empty query without calling pinecone', async () => {
    const client = makeStubClient({ dense: [], rerankOrder: [] });
    const retriever = createRetriever(CONFIG, {
      pinecone: client,
      bm25: buildBm25(),
      chunks: FIXTURE,
    });
    const out = await retriever.retrieve('   ');
    expect(out).toEqual([]);
    expect(client.denseSearch).not.toHaveBeenCalled();
    expect(client.rerank).not.toHaveBeenCalled();
  });

  it('passes the rerank model and fallback model through to the client', async () => {
    const client = makeStubClient({
      dense: [{ id: 'doc1', score: 0.9 }],
      rerankOrder: ['doc1'],
    });
    const retriever = createRetriever(CONFIG, {
      pinecone: client,
      bm25: buildBm25(),
      chunks: FIXTURE,
    });
    await retriever.retrieve('diabetes');
    const rerankCall = (client.rerank as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    expect(rerankCall[0]).toBe(CONFIG.rerankModel);
    expect(rerankCall[1]).toBe(CONFIG.rerankFallbackModel);
  });
});
