#!/usr/bin/env node
/**
 * Combine per-chapter `extracted/chapter-NN.json` files into the
 * committed `ada-standards-of-care-2026.json` corpus. Existing chunks
 * for chapters present in `KEEP_FROM_EXISTING` are preserved verbatim
 * (preserves the exact insertion order of the prior corpus, minimising
 * commit churn). New chapters are appended in chapter-number order.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CORPUS_DIR = join(__dirname, '..', 'data', 'corpus');
const COMBINED_PATH = join(CORPUS_DIR, 'ada-standards-of-care-2026.json');

// First-page numbers (S{N} → N) and article URLs per chapter.
const CHAPTER_META = {
  1: { page: 13, url: 'https://diabetesjournals.org/care/article/49/Supplement_1/S13/163920/1-Improving-Care-and-Promoting-Health-in' },
  2: { page: 27, url: 'https://diabetesjournals.org/care/article/49/Supplement_1/S27/163926/2-Diagnosis-and-Classification-of-Diabetes' },
  3: { page: 50, url: 'https://diabetesjournals.org/care/article/49/Supplement_1/S50/163924/3-Prevention-or-Delay-of-Diabetes-and-Associated' },
  4: { page: 61, url: 'https://diabetesjournals.org/care/article/49/Supplement_1/S61/163931/4-Comprehensive-Medical-Evaluation-and-Assessment' },
  5: { page: 89, url: 'https://diabetesjournals.org/care/article/49/Supplement_1/S89/163932/5-Facilitating-Positive-Health-Behaviors-and-Well' },
  6: { page: 132, url: 'https://diabetesjournals.org/care/article/49/Supplement_1/S132/163927/6-Glycemic-Goals-Hypoglycemia-and-Hyperglycemic' },
  7: { page: 150, url: 'https://diabetesjournals.org/care/article/49/Supplement_1/S150/163922/7-Diabetes-Technology-Standards-of-Care-in' },
  8: { page: 166, url: 'https://diabetesjournals.org/care/article/49/Supplement_1/S166/163915/8-Obesity-and-Weight-Management-for-the-Prevention' },
  9: { page: 183, url: 'https://diabetesjournals.org/care/article/49/Supplement_1/S183/163934/9-Pharmacologic-Approaches-to-Glycemic-Treatment' },
  10: { page: 216, url: 'https://diabetesjournals.org/care/article/49/Supplement_1/S216/163933/10-Cardiovascular-Disease-and-Risk-Management' },
  11: { page: 246, url: 'https://diabetesjournals.org/care/article/49/Supplement_1/S246/163914/11-Chronic-Kidney-Disease-and-Risk-Management' },
  12: { page: 261, url: 'https://diabetesjournals.org/care/article/49/Supplement_1/S261/163919/12-Retinopathy-Neuropathy-and-Foot-Care-Standards' },
  13: { page: 277, url: 'https://diabetesjournals.org/care/article/49/Supplement_1/S277/163921/13-Older-Adults-Standards-of-Care-in-Diabetes-2026' },
  14: { page: 297, url: 'https://diabetesjournals.org/care/article/49/Supplement_1/S297/163923/14-Children-and-Adolescents-Standards-of-Care-in' },
  15: { page: 321, url: 'https://diabetesjournals.org/care/article/49/Supplement_1/S321/163918/15-Management-of-Diabetes-in-Pregnancy-Standards' },
  16: { page: 339, url: 'https://diabetesjournals.org/care/article/49/Supplement_1/S339/163925/16-Diabetes-Care-in-the-Hospital-Standards-of-Care' },
};

// Chapters whose existing committed chunks we preserve verbatim. The
// re-parsed extracted JSON is byte-identical to the committed body for
// these chapters (validated upstream); preserving the original chunk
// objects keeps the diff focused on the new chapters.
const KEEP_FROM_EXISTING = new Set([2, 4, 6, 9, 10, 11]);

// Chapters with zero numbered recommendations — recorded for the commit
// body, not appended to the corpus.
const SKIPPED = [{ chapter: 17, reason: 'narrative-only — no numbered recommendations' }];

async function main() {
  const existing = JSON.parse(await readFile(COMBINED_PATH, 'utf8'));
  const existingByChapter = new Map();
  for (const c of existing.chunks) {
    const ch = parseInt(c.section_id.split('.')[0], 10);
    if (!existingByChapter.has(ch)) existingByChapter.set(ch, []);
    existingByChapter.get(ch).push(c);
  }

  const newChunks = [];

  // Preserve existing chapters in their original order.
  for (const c of existing.chunks) {
    const ch = parseInt(c.section_id.split('.')[0], 10);
    if (KEEP_FROM_EXISTING.has(ch)) newChunks.push(c);
  }

  // Append new chapters in numeric chapter order.
  const newChapterNumbers = Object.keys(CHAPTER_META)
    .map(n => parseInt(n, 10))
    .filter(n => !KEEP_FROM_EXISTING.has(n))
    .sort((a, b) => a - b);

  const perChapterCount = {};

  for (const ch of newChapterNumbers) {
    const meta = CHAPTER_META[ch];
    const nn = String(ch).padStart(2, '0');
    const path = join(CORPUS_DIR, 'extracted', `chapter-${nn}.json`);
    const recs = JSON.parse(await readFile(path, 'utf8'));
    perChapterCount[ch] = recs.length;
    for (const r of recs) {
      const chunk = {
        section_id: r.section_id,
        page: meta.page,
        body: r.body,
        source_url: meta.url,
      };
      if (r.grade) chunk.grade = r.grade;
      newChunks.push(chunk);
    }
  }

  const out = {
    source: existing.source,
    version: existing.version,
    fetched_at: existing.fetched_at,
    chunks: newChunks,
  };

  await writeFile(COMBINED_PATH, JSON.stringify(out, null, 2) + '\n', 'utf8');

  // Summary
  const total = newChunks.length;
  const summary = {
    total,
    new_chapter_counts: perChapterCount,
    kept_chapter_counts: Object.fromEntries(
      [...KEEP_FROM_EXISTING].sort((a, b) => a - b).map(ch => [ch, (existingByChapter.get(ch) ?? []).length]),
    ),
    skipped: SKIPPED,
  };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch(err => { console.error(err); process.exit(1); });
