/**
 * Layer 1 — citation grounding. Every claim must cite a row produced
 * by THIS turn's tools (D9). rule:* IDs are exempt — they are injected
 * by Layer 2 after Layer 1 runs the next time around.
 */

import type { Answer } from '../schemas/AnswerSchema.js';

export type VerifyLayer1Result =
  | { pass: true }
  | { pass: false; critique: string };

export function verifyLayer1(
  draft: Answer,
  validCitationIds: Set<string>,
): VerifyLayer1Result {
  const invalid: string[] = [];

  for (const claim of draft.claims) {
    for (const cid of claim.citation_ids) {
      // Synthetic id prefixes are exempt from the row-grounding check:
      //   rule:* — injected by Layer 2 (post-grounding rules)
      //   doc:*  — AgentForge source-document attribution (doc:lab-<id>,
      //            doc:intake-<id>). The actual data is grounded via the
      //            accompanying tool:* citation; doc:* is a label.
      if (cid.startsWith('rule:')) continue;
      if (cid.startsWith('doc:')) continue;
      if (!validCitationIds.has(cid)) {
        invalid.push(cid);
      }
    }
  }

  if (invalid.length === 0) {
    return { pass: true };
  }

  const unique = Array.from(new Set(invalid));
  const critique =
    `Invalid citation IDs from this turn's tool results: ${unique.join(', ')}. ` +
    `Only cite rows returned by the current turn's tool calls.`;

  return { pass: false, critique };
}
