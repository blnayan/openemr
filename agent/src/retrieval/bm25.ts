/**
 * In-process BM25 index for the sparse half of the hybrid retriever.
 *
 * Built once at startup over the same chunk set Pinecone is populated
 * with, so every chunk is reachable through both paths and RRF can
 * fuse them. Pure in-memory, no I/O — the ingest script writes a JSON
 * sidecar (term postings + doc lengths) that the retriever hot-loads
 * on cold start.
 *
 * Tokenization: lowercase, strip non-alphanumeric to spaces, split on
 * whitespace, drop tokens shorter than 2 chars and a small stopword
 * set. Deliberately simple — guideline text is curated and short, and
 * a heavier tokenizer (stemming, n-grams) would hurt determinism in
 * tests without measurable retrieval gains for ~50–250 chunks.
 */

import type { Chunk } from './types.js';

const DEFAULT_STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from',
  'has', 'in', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'this',
  'to', 'with', 'was', 'were', 'will', 'be', 'been', 'have', 'had',
]);

export interface Bm25Hit {
  readonly id: string;
  readonly score: number;
}

export interface SerializedBm25 {
  readonly version: 1;
  readonly k1: number;
  readonly b: number;
  readonly avgdl: number;
  readonly docLengths: Record<string, number>;
  readonly postings: Record<string, Array<[string, number]>>;
}

export interface Bm25Options {
  readonly k1?: number;
  readonly b?: number;
  readonly stopwords?: ReadonlySet<string>;
}

export function tokenize(text: string, stopwords: ReadonlySet<string> = DEFAULT_STOPWORDS): readonly string[] {
  const normalized = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  const out: string[] = [];
  for (const tok of normalized.split(/\s+/)) {
    if (tok.length < 2) continue;
    if (stopwords.has(tok)) continue;
    out.push(tok);
  }
  return out;
}

export class Bm25Index {
  /** Document term-frequency: postings[term] -> list of [docId, tf]. */
  private readonly postings = new Map<string, Map<string, number>>();
  /** Per-document token count (used for length normalisation). */
  private readonly docLengths = new Map<string, number>();
  private avgdl = 0;
  private readonly k1: number;
  private readonly b: number;
  private readonly stopwords: ReadonlySet<string>;

  constructor(opts: Bm25Options = {}) {
    this.k1 = opts.k1 ?? 1.2;
    this.b = opts.b ?? 0.75;
    this.stopwords = opts.stopwords ?? DEFAULT_STOPWORDS;
  }

  add(chunks: readonly Chunk[]): void {
    for (const chunk of chunks) {
      const tokens = tokenize(chunk.body, this.stopwords);
      this.docLengths.set(chunk.id, tokens.length);
      const tf = new Map<string, number>();
      for (const t of tokens) {
        tf.set(t, (tf.get(t) ?? 0) + 1);
      }
      for (const [term, count] of tf.entries()) {
        let posting = this.postings.get(term);
        if (!posting) {
          posting = new Map<string, number>();
          this.postings.set(term, posting);
        }
        posting.set(chunk.id, count);
      }
    }
    this.recomputeAvgdl();
  }

  /**
   * BM25 search. Returns hits sorted by descending score, with at most
   * `topK` entries. Ties are broken by document id (lexicographic) so
   * tests are deterministic.
   */
  search(query: string, topK: number): readonly Bm25Hit[] {
    if (this.docLengths.size === 0) return [];
    const queryTerms = tokenize(query, this.stopwords);
    if (queryTerms.length === 0) return [];

    const N = this.docLengths.size;
    const scores = new Map<string, number>();

    // De-duplicate query terms: BM25 contribution per term is independent of
    // how many times the term appears in the query.
    const seen = new Set<string>();
    for (const term of queryTerms) {
      if (seen.has(term)) continue;
      seen.add(term);
      const posting = this.postings.get(term);
      if (!posting) continue;
      const df = posting.size;
      // Robertson/Sparck Jones IDF with the +0.5 smoothing.
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      for (const [docId, tf] of posting.entries()) {
        const dl = this.docLengths.get(docId) ?? 0;
        const denom = tf + this.k1 * (1 - this.b + this.b * (dl / (this.avgdl || 1)));
        const contrib = idf * ((tf * (this.k1 + 1)) / denom);
        scores.set(docId, (scores.get(docId) ?? 0) + contrib);
      }
    }

    return Array.from(scores.entries())
      .sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
      })
      .slice(0, topK)
      .map(([id, score]) => ({ id, score }));
  }

  serialize(): SerializedBm25 {
    const postings: Record<string, Array<[string, number]>> = {};
    for (const [term, docs] of this.postings.entries()) {
      postings[term] = Array.from(docs.entries());
    }
    const docLengths: Record<string, number> = {};
    for (const [id, len] of this.docLengths.entries()) {
      docLengths[id] = len;
    }
    return {
      version: 1,
      k1: this.k1,
      b: this.b,
      avgdl: this.avgdl,
      docLengths,
      postings,
    };
  }

  static deserialize(data: SerializedBm25, opts: Bm25Options = {}): Bm25Index {
    const idx = new Bm25Index({
      k1: opts.k1 ?? data.k1,
      b: opts.b ?? data.b,
      ...(opts.stopwords !== undefined ? { stopwords: opts.stopwords } : {}),
    });
    for (const [id, len] of Object.entries(data.docLengths)) {
      idx.docLengths.set(id, len);
    }
    for (const [term, entries] of Object.entries(data.postings)) {
      idx.postings.set(term, new Map(entries));
    }
    idx.avgdl = data.avgdl;
    return idx;
  }

  private recomputeAvgdl(): void {
    if (this.docLengths.size === 0) {
      this.avgdl = 0;
      return;
    }
    let total = 0;
    for (const len of this.docLengths.values()) total += len;
    this.avgdl = total / this.docLengths.size;
  }
}
