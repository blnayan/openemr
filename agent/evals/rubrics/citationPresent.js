/**
 * citationPresent — every claim has at least one citation.
 *
 * Counts as "having a citation" if either:
 *   - `citation_ids` is a non-empty array (legacy Week 1 form), OR
 *   - `citations` is a non-empty array of rich Citation objects (Week 2).
 *
 * Empty answers (zero claims) are accepted — that's a refusal-shaped
 * answer and is the `safeRefusal` rubric's concern, not this one.
 */

import { extractAnswer, pass, fail } from './_helpers.js';

export default async function citationPresent(output, _context) {
  const answer = extractAnswer(output);
  if (!answer) return fail('no Answer-shaped payload could be extracted');

  const claims = Array.isArray(answer.claims) ? answer.claims : [];
  // No claims = vacuously true for this rubric. Refusal handling lives
  // in safeRefusal.
  if (claims.length === 0) return pass('no claims to check');

  for (let i = 0; i < claims.length; i++) {
    const c = claims[i];
    const idsLen = Array.isArray(c?.citation_ids) ? c.citation_ids.length : 0;
    const richLen = Array.isArray(c?.citations) ? c.citations.length : 0;
    if (idsLen + richLen === 0) {
      const text = typeof c?.text === 'string' ? c.text.slice(0, 80) : '<no text>';
      return fail(`claim[${i}] has no citation: "${text}"`);
    }
  }
  return pass(`all ${claims.length} claims carry citations`);
}
