/**
 * Reciprocal rank fusion unit tests. Verify the formula against
 * hand-computed expectations.
 */

import { describe, expect, it } from 'vitest';
import { reciprocalRankFusion } from '../../../src/retrieval/rrf.js';

describe('reciprocalRankFusion', () => {
  it('fuses two ranked lists with overlap and sorts by RRF score', () => {
    // List A:  a (rank 1), b (rank 2), c (rank 3)
    // List B:  b (rank 1), c (rank 2), d (rank 3)
    // With k = 60, hand-computed expected scores:
    //   a: 1/(60+1) = 1/61
    //   b: 1/(60+2) + 1/(60+1) = 1/62 + 1/61
    //   c: 1/(60+3) + 1/(60+2) = 1/63 + 1/62
    //   d: 1/(60+3) = 1/63
    // Order: b > c > a > d.
    const fused = reciprocalRankFusion(
      [
        [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
        [{ id: 'b' }, { id: 'c' }, { id: 'd' }],
      ],
      60,
    );
    expect(fused.map(f => f.id)).toEqual(['b', 'c', 'a', 'd']);

    const score = (id: string) => fused.find(f => f.id === id)!.score;
    expect(score('a')).toBeCloseTo(1 / 61, 12);
    expect(score('b')).toBeCloseTo(1 / 62 + 1 / 61, 12);
    expect(score('c')).toBeCloseTo(1 / 63 + 1 / 62, 12);
    expect(score('d')).toBeCloseTo(1 / 63, 12);
  });

  it('returns empty when all input lists are empty', () => {
    expect(reciprocalRankFusion([[], []])).toEqual([]);
  });

  it('handles a single non-empty list (idempotent for the inner ordering)', () => {
    const fused = reciprocalRankFusion(
      [[{ id: 'x' }, { id: 'y' }, { id: 'z' }]],
      60,
    );
    expect(fused.map(f => f.id)).toEqual(['x', 'y', 'z']);
  });

  it('breaks ties on id lexicographically for determinism', () => {
    // Single-item-each lists both at rank 1 — equal scores.
    const fused = reciprocalRankFusion(
      [
        [{ id: 'b' }],
        [{ id: 'a' }],
      ],
      60,
    );
    expect(fused.map(f => f.id)).toEqual(['a', 'b']);
  });

  it('respects custom k (smaller k amplifies top-rank advantage)', () => {
    const k = 1;
    const fused = reciprocalRankFusion(
      [
        [{ id: 'a' }, { id: 'b' }],
        [{ id: 'b' }, { id: 'a' }],
      ],
      k,
    );
    // Both items appear in both lists, ranks (1,2) and (2,1) — symmetric.
    // Scores are equal; lexicographic tiebreak gives 'a' first.
    expect(fused.map(f => f.id)).toEqual(['a', 'b']);
    expect(fused[0]!.score).toBeCloseTo(1 / 2 + 1 / 3, 12);
    expect(fused[1]!.score).toBeCloseTo(1 / 3 + 1 / 2, 12);
  });

  it('rejects k <= 0', () => {
    expect(() => reciprocalRankFusion([[{ id: 'a' }]], 0)).toThrow();
    expect(() => reciprocalRankFusion([[{ id: 'a' }]], -1)).toThrow();
  });
});
