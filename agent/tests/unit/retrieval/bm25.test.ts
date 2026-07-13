/**
 * BM25 unit tests. Drive the index with a small fixture corpus so
 * scoring behaviour is fully deterministic.
 */

import { describe, expect, it } from 'vitest';
import { Bm25Index, tokenize } from '../../../src/retrieval/bm25.js';
import type { Chunk } from '../../../src/retrieval/types.js';

const FIXTURE: readonly Chunk[] = [
  { id: 'doc1', source: 'fixture', section_id: '1', page: 1, body: 'Diabetes screening should occur at age 35 for asymptomatic adults.' },
  { id: 'doc2', source: 'fixture', section_id: '2', page: 2, body: 'Hypertension blood pressure target is below 130/80 mmHg in diabetic patients.' },
  { id: 'doc3', source: 'fixture', section_id: '3', page: 3, body: 'Hemoglobin A1c diagnostic threshold for diabetes is 6.5 percent.' },
  { id: 'doc4', source: 'fixture', section_id: '4', page: 4, body: 'Statin therapy is recommended for primary prevention in diabetes aged 40 to 75.' },
  { id: 'doc5', source: 'fixture', section_id: '5', page: 5, body: 'Foot examination should be performed annually for patients with diabetes.' },
  { id: 'doc6', source: 'fixture', section_id: '6', page: 6, body: 'Eye examination by an ophthalmologist within 5 years of type 1 diabetes onset.' },
  { id: 'doc7', source: 'fixture', section_id: '7', page: 7, body: 'Hypoglycemia level 1 is a glucose level less than 70 mg per deciliter.' },
  { id: 'doc8', source: 'fixture', section_id: '8', page: 8, body: 'Glucagon should be prescribed for individuals at increased risk of hypoglycemia.' },
  { id: 'doc9', source: 'fixture', section_id: '9', page: 9, body: 'SGLT2 inhibitors are recommended in type 2 diabetes with chronic kidney disease.' },
  { id: 'doc10', source: 'fixture', section_id: '10', page: 10, body: 'Aspirin therapy may be considered as primary prevention in diabetes at increased cardiovascular risk.' },
];

describe('tokenize', () => {
  it('lowercases, strips punctuation, drops short tokens and stopwords', () => {
    expect(tokenize('Diabetes IS a Chronic Disease.')).toEqual(['diabetes', 'chronic', 'disease']);
  });

  it('keeps multi-char digit-bearing tokens and drops bare 1-char tokens', () => {
    // '6' and '5' are 1-char tokens after splitting on non-alphanumerics
    // and are dropped; 'a1c' survives.
    expect(tokenize('A1c >= 6.5%')).toEqual(['a1c']);
  });
});

describe('Bm25Index', () => {
  it('returns hits sorted by descending score, capped at topK', () => {
    const idx = new Bm25Index();
    idx.add(FIXTURE);
    const hits = idx.search('diabetes screening adults', 3);
    expect(hits).toHaveLength(3);
    expect(hits[0]!.id).toBe('doc1'); // contains both 'screening' and 'adults'
    // hits should be in non-increasing score order
    for (let i = 1; i < hits.length; i += 1) {
      expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
    }
  });

  it('ranks hypoglycemia query with hypoglycemia chunks first', () => {
    const idx = new Bm25Index();
    idx.add(FIXTURE);
    const hits = idx.search('hypoglycemia glucose', 3);
    const ids = hits.map(h => h.id);
    // doc7 mentions both 'hypoglycemia' and 'glucose'; doc8 mentions only 'hypoglycemia'.
    expect(ids[0]).toBe('doc7');
    expect(ids).toContain('doc8');
  });

  it('returns empty for a query containing only stopwords', () => {
    const idx = new Bm25Index();
    idx.add(FIXTURE);
    expect(idx.search('the and of', 5)).toEqual([]);
  });

  it('returns empty when index is empty', () => {
    const idx = new Bm25Index();
    expect(idx.search('diabetes', 5)).toEqual([]);
  });

  it('breaks ties on doc id deterministically', () => {
    // Two chunks with identical text yield identical scores; verify the
    // tiebreaker keeps the lexicographically-smaller id first.
    const idx = new Bm25Index();
    idx.add([
      { id: 'b', source: 'f', section_id: 'b', page: 0, body: 'apple banana cherry' },
      { id: 'a', source: 'f', section_id: 'a', page: 0, body: 'apple banana cherry' },
    ]);
    const hits = idx.search('apple banana', 2);
    expect(hits.map(h => h.id)).toEqual(['a', 'b']);
  });

  it('round-trips through serialize/deserialize', () => {
    const idx = new Bm25Index();
    idx.add(FIXTURE);
    const serialized = idx.serialize();
    const restored = Bm25Index.deserialize(serialized);
    const a = idx.search('diabetes screening', 5);
    const b = restored.search('diabetes screening', 5);
    expect(b).toEqual(a);
  });
});
