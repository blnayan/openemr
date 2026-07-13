/**
 * Guideline citation verifier — fail-closed substring check.
 *
 * For every claim that carries a `guideline` citation, we require the
 * citation's `quoted_span` to be a substring of the named chunk's body
 * after whitespace normalization (NFC + collapse-runs-to-single-space +
 * trim — no fuzzy matching, no model-judged "this paraphrase is close
 * enough"). A claim survives only if every one of its `guideline`
 * citations passes; the first failing citation drops the entire claim.
 *
 * Non-guideline citations (`patient_record`, `patient_document`) are
 * passed through unverified at this layer — the Week 1 verifier
 * (`verifyLayer1`) handles `patient_record` ids, and the second-pass
 * crop verifier (issue 07) will handle `patient_document` regions.
 *
 * If the verifier drops every claim from an answer, callers should
 * downgrade the response to a low-confidence refusal per W2_PRD §"Synthesis
 * at the supervisor level" — `verifyGuidelineCitations` reports this via
 * `kept.length === 0` so callers can branch deterministically.
 */

import type { Claim, Citation } from '../schemas/AnswerSchema.js';
import type { RankedChunk } from '../retrieval/types.js';

export interface VerifyDropReason {
  readonly claim: Claim;
  readonly reason:
    | { readonly kind: 'unknown_chunk'; readonly chunk_id: string }
    | { readonly kind: 'quote_not_substring'; readonly chunk_id: string; readonly quoted_span: string };
}

export interface VerifyResult {
  readonly kept: readonly Claim[];
  readonly dropped: readonly VerifyDropReason[];
}

/**
 * Verify guideline citations for every claim. Pure function; no I/O.
 *
 * @param claims  — claims to verify, in order.
 * @param chunks  — chunks the synthesizer was shown. Used both to
 *                  resolve `chunk_id` -> body and to gate which chunks
 *                  the claim is allowed to cite.
 */
export function verifyGuidelineCitations(
  claims: readonly Claim[],
  chunks: readonly RankedChunk[],
): VerifyResult {
  const byId = new Map<string, RankedChunk>();
  for (const c of chunks) byId.set(c.id, c);

  const kept: Claim[] = [];
  const dropped: VerifyDropReason[] = [];

  for (const claim of claims) {
    const guidelineCits = (claim.citations ?? []).filter(isGuideline);
    if (guidelineCits.length === 0) {
      // No guideline citations on this claim — nothing for the substring
      // check to verify. Keep as-is; other layers handle non-guideline
      // citations.
      kept.push(claim);
      continue;
    }

    let dropReason: VerifyDropReason | null = null;
    for (const cit of guidelineCits) {
      const chunk = byId.get(cit.chunk_id);
      if (!chunk) {
        dropReason = { claim, reason: { kind: 'unknown_chunk', chunk_id: cit.chunk_id } };
        break;
      }
      if (!isSubstringNormalized(cit.quoted_span, chunk.body)) {
        dropReason = {
          claim,
          reason: { kind: 'quote_not_substring', chunk_id: cit.chunk_id, quoted_span: cit.quoted_span },
        };
        break;
      }
    }

    if (dropReason) {
      dropped.push(dropReason);
    } else {
      kept.push(claim);
    }
  }

  return { kept, dropped };
}

function isGuideline(c: Citation): c is Extract<Citation, { type: 'guideline' }> {
  return c.type === 'guideline';
}

/**
 * Whitespace-normalized substring check. Collapses any run of Unicode
 * whitespace (spaces, tabs, newlines, NBSP, etc.) to a single ASCII
 * space, NFC-normalizes both sides, trims, then runs `String#includes`.
 *
 * Exported so unit tests can assert the boundary directly without
 * having to assemble a full `Claim` and `RankedChunk`.
 */
export function isSubstringNormalized(needle: string, haystack: string): boolean {
  const n = normalize(needle);
  const h = normalize(haystack);
  if (n.length === 0) return false;
  return h.includes(n);
}

function normalize(s: string): string {
  return s.normalize('NFC').replace(/\s+/g, ' ').trim();
}
