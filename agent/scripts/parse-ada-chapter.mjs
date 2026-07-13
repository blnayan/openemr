#!/usr/bin/env node
/**
 * Parse a cached ADA Standards of Care 2026 chapter HTML file into the
 * per-chapter extracted JSON shape used under
 * `agent/data/corpus/extracted/`.
 *
 * Usage:
 *   node scripts/parse-ada-chapter.mjs <chapter-number>
 *
 * Reads:  agent/data/corpus/raw/chapter-NN.html
 * Writes: agent/data/corpus/extracted/chapter-NN.json
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CORPUS_DIR = join(__dirname, '..', 'data', 'corpus');

const SECTION_RE = /^[0-9]+(?:\.[0-9]+[a-z]?)?$/;

function parseHtml(rawHtml) {
  // Normalisation pass: tighten whitespace edge cases so .text() yields
  // human-readable copy even when the source HTML elides spaces between
  // structural tags.
  //   - `</sup>` followed by an ASCII letter typically means a unit
  //     concatenated with the next word (e.g. `m<sup>2</sup>but` →
  //     `m2 but`). Insert a space.
  //   - `<span class="screenreader-text">…</span>` is for assistive
  //     tech; strip it so it does not leak into the body. Typically
  //     paired with a sibling `<strong>` containing the visible link
  //     label (e.g. `Fig. 9.4`).
  //   - `<a class="link link-uri" …>…</a>` is a cross-chapter link
  //     whose visible content is just the screenreader phrase. Drop the
  //     anchor; the surrounding parens collapse to `()` which the final
  //     whitespace pass cleans up.
  const html = rawHtml
    .replace(/<\/sup>(?=[A-Za-z])/g, '</sup> ')
    .replace(/<span class="screenreader-text">[\s\S]*?<\/span>/g, '')
    .replace(/<a class="link link-uri"[^>]*>[\s\S]*?<\/a>/g, '');

  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();

  // Recommendations live in `<p>` blocks that start with `<strong>{section_id}</strong>`.
  // Most are wrapped in `<li><p>...</p></li>`, but some chapters
  // (e.g. ch 2 sections 2.11–2.29) emit bare `<p>` paragraphs.
  $('p').each((_, p) => {
    const $p = $(p);
    const $firstStrong = $p.children('strong').first();
    if ($firstStrong.length === 0) return;
    // The section-id strong must be the first non-whitespace child.
    const firstChild = $p.contents().get(0);
    if (!firstChild) return;
    if (firstChild.type === 'tag' && firstChild.name !== 'strong') return;
    if (firstChild.type === 'text' && firstChild.data.trim() !== '') return;
    const sectionId = $firstStrong.text().trim();
    if (!SECTION_RE.test(sectionId)) return;
    if (seen.has(sectionId)) return;
    seen.add(sectionId);

    // Clone and remove the leading section_id strong.
    const $clone = $p.clone();
    $clone.children('strong').first().remove();

    // The grade letter is the LAST direct-child <strong> whose text is
    // exactly A/B/C/E. We do NOT remove it from the DOM — when it is a
    // mid-paragraph sub-clause grade (e.g. ch 2 sec 2.31a, ch 9 sec 9.11)
    // its letter remains inline in the body text. Whether it is a
    // trailing or mid grade, only its presence on the strong is what
    // identifies it as the recommendation grade. If the letter is the
    // very last token of the paragraph, the trim/whitespace collapse
    // below removes the trailing isolated letter naturally.
    const $strongs = $clone.children('strong');
    let grade;
    if ($strongs.length > 0) {
      const $last = $strongs.last();
      const lastText = $last.text().trim();
      if (/^[ABCE]$/.test(lastText)) {
        grade = lastText;
        // Only remove the strong from the body if it is the trailing
        // node of the paragraph (no meaningful text/element follows).
        let isTrailing = true;
        let node = $last.get(0).next;
        while (node) {
          if (node.type === 'text') {
            if (node.data.replace(/\s+/g, '').length > 0) { isTrailing = false; break; }
          } else {
            isTrailing = false;
            break;
          }
          node = node.next;
        }
        if (isTrailing) $last.remove();
      }
    }

    let body = $clone.text().replace(/\s+/g, ' ').trim();
    // Empty `()` left over from stripping a cross-chapter link plus its
    // surrounding parens, plus any leading-space-before-period.
    body = body
      .replace(/\s*\(\s*\)/g, '')
      .replace(/\s*\[\s*\]/g, '')
      .replace(/\s+([.,;:])/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
    if (body.length === 0) return;
    // Skip intro stems that introduce a sub-list (no grade, body ends with ":").
    if (!grade && body.endsWith(':')) return;

    const entry = { section_id: sectionId, body };
    if (grade) entry.grade = grade;
    out.push(entry);
  });

  return out;
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('usage: parse-ada-chapter.mjs <chapter-number>');
    process.exit(1);
  }
  const nn = String(parseInt(arg, 10)).padStart(2, '0');
  const inputPath = join(CORPUS_DIR, 'raw', `chapter-${nn}.html`);
  const outputPath = join(CORPUS_DIR, 'extracted', `chapter-${nn}.json`);
  const html = await readFile(inputPath, 'utf8');
  const recs = parseHtml(html);
  await writeFile(outputPath, JSON.stringify(recs), 'utf8');
  console.log(JSON.stringify({ chapter: nn, count: recs.length, output: outputPath }));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
