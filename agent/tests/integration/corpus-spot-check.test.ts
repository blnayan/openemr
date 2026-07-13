/**
 * Spot-check that the committed ADA Standards of Care 2026 corpus is the
 * verbatim-sourced corpus (issue 05 follow-up), not the previous
 * paraphrased fixture. This is a regression guard, not a Pinecone
 * round-trip — it reads the JSON file directly.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CORPUS_PATH = join(
  __dirname,
  '..',
  '..',
  'data',
  'corpus',
  'ada-standards-of-care-2026.json',
);

interface CorpusChunk {
  readonly section_id: string;
  readonly page: number;
  readonly body: string;
  readonly grade?: 'A' | 'B' | 'C' | 'E';
  readonly source_url?: string;
}

interface Corpus {
  readonly source: string;
  readonly version: string;
  readonly fetched_at?: string;
  readonly note?: string;
  readonly chunks: ReadonlyArray<CorpusChunk>;
}

describe('ADA Standards of Care 2026 corpus', () => {
  it('is the verbatim-sourced 2026 corpus, not the paraphrased fixture', async () => {
    const raw = await readFile(CORPUS_PATH, 'utf8');
    const corpus = JSON.parse(raw) as Corpus;

    expect(corpus.source).toBe('ADA Standards of Care in Diabetes—2026');
    expect(corpus.version).toMatch(/^2026/);
    // No paraphrase disclaimer.
    expect(corpus.note ?? '').not.toMatch(/paraphras/i);
    expect(corpus.note ?? '').not.toMatch(/curated/i);
  });

  it('covers every required chapter with a high total chunk count', async () => {
    const raw = await readFile(CORPUS_PATH, 'utf8');
    const corpus = JSON.parse(raw) as Corpus;

    // Floor sits comfortably below the actual total so future small
    // edits do not break the test, but high enough to detect a broken
    // ingest pipeline.
    expect(corpus.chunks.length).toBeGreaterThanOrEqual(450);

    const chapters = new Set(
      corpus.chunks.map(c => c.section_id.split('.', 1)[0]),
    );
    // Every chapter that contains numbered recommendations in the
    // ADA Standards of Care 2026 should be represented. Chapter 17
    // (Diabetes Advocacy) is intentionally absent — its 2026 version
    // contains only narrative advocacy statements with no numbered
    // recommendations.
    for (const required of [
      '1', '2', '3', '4', '5', '6', '7', '8', '9',
      '10', '11', '12', '13', '14', '15', '16',
    ]) {
      expect(chapters.has(required), `missing chapter ${required}`).toBe(true);
    }
  });

  it('covers chapter-7 technology guidance (CGM)', async () => {
    const raw = await readFile(CORPUS_PATH, 'utf8');
    const corpus = JSON.parse(raw) as Corpus;
    const ch7 = corpus.chunks.filter(c => c.section_id.startsWith('7.'));
    expect(ch7.length).toBeGreaterThan(0);
    expect(
      ch7.some(c => /CGM|continuous glucose/i.test(c.body)),
    ).toBe(true);
  });

  it('covers chapter-8 obesity / weight guidance', async () => {
    const raw = await readFile(CORPUS_PATH, 'utf8');
    const corpus = JSON.parse(raw) as Corpus;
    const ch8 = corpus.chunks.filter(c => c.section_id.startsWith('8.'));
    expect(ch8.length).toBeGreaterThan(0);
    expect(
      ch8.some(c => /BMI|weight/i.test(c.body)),
    ).toBe(true);
  });

  it('covers chapter-12 retinopathy / neuropathy / foot care', async () => {
    const raw = await readFile(CORPUS_PATH, 'utf8');
    const corpus = JSON.parse(raw) as Corpus;
    const ch12 = corpus.chunks.filter(c => c.section_id.startsWith('12.'));
    expect(ch12.length).toBeGreaterThan(0);
    expect(
      ch12.some(c => /retinopathy|neuropathy|foot/i.test(c.body)),
    ).toBe(true);
  });

  it('covers chapter-13 older adults', async () => {
    const raw = await readFile(CORPUS_PATH, 'utf8');
    const corpus = JSON.parse(raw) as Corpus;
    const ch13 = corpus.chunks.filter(c => c.section_id.startsWith('13.'));
    expect(ch13.length).toBeGreaterThan(0);
  });

  it('covers chapter-14 children / adolescents', async () => {
    const raw = await readFile(CORPUS_PATH, 'utf8');
    const corpus = JSON.parse(raw) as Corpus;
    const ch14 = corpus.chunks.filter(c => c.section_id.startsWith('14.'));
    expect(ch14.length).toBeGreaterThan(0);
  });

  it('covers chapter-15 management of diabetes in pregnancy', async () => {
    const raw = await readFile(CORPUS_PATH, 'utf8');
    const corpus = JSON.parse(raw) as Corpus;
    const ch15 = corpus.chunks.filter(c => c.section_id.startsWith('15.'));
    expect(ch15.length).toBeGreaterThan(0);
    expect(
      ch15.some(c => /pregnan/i.test(c.body)),
    ).toBe(true);
  });

  it('covers chapter-16 hospital care', async () => {
    const raw = await readFile(CORPUS_PATH, 'utf8');
    const corpus = JSON.parse(raw) as Corpus;
    const ch16 = corpus.chunks.filter(c => c.section_id.startsWith('16.'));
    expect(ch16.length).toBeGreaterThan(0);
    expect(
      ch16.some(c => /hospital|inpatient/i.test(c.body)),
    ).toBe(true);
  });

  it('contains pharmacologic guidance (chapter 9, mentions metformin)', async () => {
    const raw = await readFile(CORPUS_PATH, 'utf8');
    const corpus = JSON.parse(raw) as Corpus;

    const ch9 = corpus.chunks.filter(c => c.section_id.startsWith('9.'));
    expect(ch9.length).toBeGreaterThan(0);

    const mentionsMetformin = corpus.chunks.some(c =>
      /metformin/i.test(c.body),
    );
    expect(mentionsMetformin).toBe(true);
  });

  it('contains glycemic-goal guidance (chapter 6, mentions A1C or glycemic)', async () => {
    const raw = await readFile(CORPUS_PATH, 'utf8');
    const corpus = JSON.parse(raw) as Corpus;

    const ch6 = corpus.chunks.filter(c => c.section_id.startsWith('6.'));
    expect(ch6.length).toBeGreaterThan(0);

    const mentionsGlycemicTarget = ch6.some(c =>
      /A1[Cc]|glycemi/.test(c.body),
    );
    expect(mentionsGlycemicTarget).toBe(true);
  });

  it('carries grade and source_url metadata on most chunks', async () => {
    const raw = await readFile(CORPUS_PATH, 'utf8');
    const corpus = JSON.parse(raw) as Corpus;

    const withGrade = corpus.chunks.filter(c => c.grade !== undefined).length;
    const withUrl = corpus.chunks.filter(c => c.source_url !== undefined).length;

    // Some recommendations are intro paragraphs without a grade letter,
    // so we tolerate a few without grade. Every chunk should carry a
    // source_url.
    expect(withGrade / corpus.chunks.length).toBeGreaterThan(0.9);
    expect(withUrl).toBe(corpus.chunks.length);
  });
});
