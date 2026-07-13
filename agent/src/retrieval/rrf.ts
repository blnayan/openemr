/**
 * Reciprocal rank fusion. Used to merge dense (Pinecone) and sparse
 * (BM25) ranked lists into a single fused list before reranking.
 *
 * RRF formula (Cormack et al., 2009):
 *
 *   score(d) = sum_over_lists( 1 / (k + rank_in_list(d)) )
 *
 * where `rank_in_list` is 1-indexed and `k` is a smoothing constant
 * (60 in the original paper, used widely as a default). Documents that
 * appear in only one list still contribute, but rank-near-the-top in
 * both lists wins decisively.
 */

export interface RankedItem {
  readonly id: string;
}

export interface FusedItem {
  readonly id: string;
  readonly score: number;
}

/**
 * Fuse N ranked lists. Each list is interpreted as already sorted in
 * descending relevance order; only the order matters, scores are
 * ignored. Returns a fused list sorted by descending RRF score, with
 * ties broken lexicographically by id for determinism.
 */
export function reciprocalRankFusion<T extends RankedItem>(
  rankedLists: ReadonlyArray<ReadonlyArray<T>>,
  k: number = 60,
): readonly FusedItem[] {
  if (k <= 0) {
    throw new Error(`RRF k must be > 0; got ${k}`);
  }
  const scores = new Map<string, number>();
  for (const list of rankedLists) {
    for (let i = 0; i < list.length; i += 1) {
      const item = list[i]!;
      const rank = i + 1;
      const contribution = 1 / (k + rank);
      scores.set(item.id, (scores.get(item.id) ?? 0) + contribution);
    }
  }
  return Array.from(scores.entries())
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    })
    .map(([id, score]) => ({ id, score }));
}
