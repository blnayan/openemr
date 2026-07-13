/**
 * EvidenceRetrieverWorker unit tests — the worker is a thin pass-through;
 * tests assert it doesn't drop, reorder, or mutate retrieve() output.
 */

import { describe, it, expect, vi } from 'vitest';
import { EvidenceRetrieverWorker } from '../../../../src/graph/workers/EvidenceRetrieverWorker.js';
import type { Retriever, RankedChunk } from '../../../../src/retrieval/types.js';

function chunk(id: string, score: number): RankedChunk {
  return {
    id,
    source: 'ADA',
    section_id: id,
    page: 1,
    body: `body of ${id}`,
    score,
  };
}

describe('EvidenceRetrieverWorker', () => {
  it('returns the retriever output unchanged', async () => {
    const chunks = [chunk('a', 0.9), chunk('b', 0.8), chunk('c', 0.7)];
    const retriever: Retriever = {
      retrieve: vi.fn().mockResolvedValue(chunks),
    };
    const worker = new EvidenceRetrieverWorker(retriever);
    const out = await worker.run({ question: 'A1C target?' });
    expect(out.chunks).toEqual(chunks);
    expect(retriever.retrieve).toHaveBeenCalledWith('A1C target?');
  });

  it('short-circuits empty / whitespace questions without calling retriever', async () => {
    const retriever: Retriever = {
      retrieve: vi.fn().mockResolvedValue([chunk('x', 1)]),
    };
    const worker = new EvidenceRetrieverWorker(retriever);
    expect((await worker.run({ question: '' })).chunks).toEqual([]);
    expect((await worker.run({ question: '   \n  ' })).chunks).toEqual([]);
    expect(retriever.retrieve).not.toHaveBeenCalled();
  });

  it('passes the question through verbatim (no normalization)', async () => {
    const retriever: Retriever = {
      retrieve: vi.fn().mockResolvedValue([]),
    };
    const worker = new EvidenceRetrieverWorker(retriever);
    await worker.run({ question: 'What does ADA say about A1C?' });
    expect(retriever.retrieve).toHaveBeenCalledWith('What does ADA say about A1C?');
  });

  it('returns empty chunks when retriever returns empty', async () => {
    const retriever: Retriever = { retrieve: vi.fn().mockResolvedValue([]) };
    const worker = new EvidenceRetrieverWorker(retriever);
    const out = await worker.run({ question: 'anything' });
    expect(out.chunks).toEqual([]);
  });
});
