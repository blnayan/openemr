/**
 * factuallyConsistent — substring check for every guideline citation
 * (and extension points for the other two citation surfaces).
 *
 * Algorithm:
 *   1. For each claim, walk its `citations[]`.
 *   2. `guideline` citations: resolve `chunk_id` against the loaded
 *      corpus and run the verifier's whitespace-normalized substring
 *      check (the same one the production verifier uses, exposed via
 *      `isSubstringNormalized` in agent/src/verification/guidelineVerifier.ts).
 *   3. `patient_record` citations: pass-through (the Week 1 verifier
 *      handles those upstream; this rubric does not re-verify them).
 *   4. `patient_document` citations: pass-through unless
 *      `context.vars.patient_documents` is provided (test-only stub —
 *      see issues/16). This is the documented mock-vs-prod split.
 *
 * Reports per-claim drop reasons in `reason` for debuggability.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSubstringNormalized } from '../../src/verification/guidelineVerifier.js';
import { extractAnswer, pass, fail } from './_helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = join(__dirname, '..', '..', 'data', 'corpus', 'ada-standards-of-care-2026.json');

let corpusCache = null;

/**
 * Load the ADA corpus and index by chunk id, mirroring the id formula
 * the ingest script uses (sourceSlug::ch-NN::section_id::ord).
 */
async function loadCorpus() {
  if (corpusCache) return corpusCache;
  try {
    const raw = await readFile(CORPUS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const sourceSlug = slugify(parsed.source);
    const seen = new Map();
    const byId = new Map();
    for (const c of parsed.chunks) {
      const key = `${sourceSlug}::${c.section_id}`;
      const ord = seen.get(key) ?? 0;
      seen.set(key, ord + 1);
      const chapter = (c.section_id.split('.', 1)[0] ?? '').padStart(2, '0');
      const id = `${sourceSlug}::ch-${chapter}::${c.section_id}::${ord}`;
      byId.set(id, c.body);
    }
    corpusCache = byId;
  } catch (e) {
    corpusCache = new Map();
  }
  return corpusCache;
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export default async function factuallyConsistent(output, context) {
  const answer = extractAnswer(output);
  if (!answer) return fail('no Answer-shaped payload could be extracted');

  const claims = Array.isArray(answer.claims) ? answer.claims : [];
  if (claims.length === 0) return pass('no claims to verify');

  // The corpus index. In tests, a caller may provide an explicit map
  // via context.vars.chunks — that path keeps the rubric unit-testable
  // without disk I/O.
  const explicitChunks = context?.vars?.chunks;
  const chunkBodyById = explicitChunks instanceof Map
    ? explicitChunks
    : (explicitChunks && typeof explicitChunks === 'object'
      ? new Map(Object.entries(explicitChunks))
      : await loadCorpus());

  // Optional patient-document stub for tests. Real production eval
  // resolves these through the extraction sidecar.
  const patientDocs = context?.vars?.patient_documents ?? null;

  const drops = [];
  for (let i = 0; i < claims.length; i++) {
    const claim = claims[i];
    const cites = Array.isArray(claim?.citations) ? claim.citations : [];
    for (const c of cites) {
      if (!c || typeof c !== 'object') {
        drops.push(`claim[${i}]: malformed citation`);
        continue;
      }
      if (c.type === 'guideline') {
        const body = chunkBodyById.get(c.chunk_id);
        if (typeof body !== 'string') {
          drops.push(`claim[${i}]: unknown chunk_id ${c.chunk_id}`);
          continue;
        }
        if (typeof c.quoted_span !== 'string' || !isSubstringNormalized(c.quoted_span, body)) {
          drops.push(`claim[${i}]: quoted_span not a substring of ${c.chunk_id}`);
        }
      } else if (c.type === 'patient_document' && patientDocs) {
        // Stub lookup for test environment only.
        const doc = patientDocs[c.extraction_id];
        if (!doc) {
          drops.push(`claim[${i}]: unknown extraction_id ${c.extraction_id}`);
        }
      }
      // patient_record citations: handled upstream by verifyLayer1; pass through.
    }
  }

  if (drops.length > 0) {
    return fail(`factually-inconsistent citations: ${drops.join('; ')}`);
  }
  return pass(`all ${claims.length} claims have substring-verified citations`);
}
