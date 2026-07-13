/**
 * Layer 1 Citation Grounding verifier unit tests
 *
 * Exercises the deterministic citation-grounding check from §3.5 / M4.
 *
 * The function takes a draft Answer and a Set<string> of valid citation IDs
 * from THIS turn's tool results, and returns pass/reject with critique.
 *
 * Key invariants:
 *   - Citation IDs not in validIds → REJECT
 *   - rule:* IDs are always exempt (injected by Layer 2, never by the model)
 *   - Citations from prior turns → REJECT (D9: this-turn-only scoping)
 *
 * Plan reference: §3.5 Layer 1, §5.3 verifyLayer1.test.ts, M4, D9
 */

import { describe, it, expect } from 'vitest';
import { verifyLayer1 } from '../../../src/verification/verifyLayer1.js';
import type { Answer } from '../../../src/schemas/AnswerSchema.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildAnswer(claimOverrides: Partial<Answer['claims'][number]>[] = []): Answer {
  const defaultClaim: Answer['claims'][number] = {
    text:         'Maria is on lisinopril 10 mg.',
    citation_ids: ['tool:get_medications:row-0'],
    severity:     'info',
  };
  return {
    summary:              'Summary.',
    claims:               claimOverrides.length > 0
      ? claimOverrides.map(o => ({ ...defaultClaim, ...o }))
      : [defaultClaim],
    conflicts:            [],
    data_gaps:            [],
    assumptions:          [],
    evidence_catalog:     [],
    followup_suggestions: [],
    confidence:           'high',
  };
}

const validIds = new Set<string>([
  'tool:get_medications:row-0',
  'tool:get_medications:row-1',
  'tool:get_vitals:row-0',
  'tool:get_recent_labs:row-0',
]);

// ---------------------------------------------------------------------------

describe('verifyLayer1 — citation grounding', () => {
  // §3.5: happy path
  it('returns pass when all citation IDs are in validIds', () => {
    const draft  = buildAnswer([{ citation_ids: ['tool:get_medications:row-0'] }]);
    const result = verifyLayer1(draft, validIds);

    expect(result.pass).toBe(true);
  });

  // §3.5: "if any claim.citation_ids is not in validIds → REJECT"
  it('returns reject when a claim cites a fabricated ID not in validIds', () => {
    const draft  = buildAnswer([{ citation_ids: ['tool:get_medications:row-999'] }]);
    const result = verifyLayer1(draft, validIds);

    expect(result.pass).toBe(false);
    if (!result.pass) {
      expect(result.critique).toContain('tool:get_medications:row-999');
      expect(result.critique.toLowerCase()).toContain('invalid');
    }
  });

  // §3.5: "Rule IDs (rule:*) are exempt — injected by Layer 2, always valid"
  it('exempts rule:* citation IDs from the validIds check', () => {
    const draft = buildAnswer([{
      citation_ids: ['rule:ddi:warfarin-ibuprofen'],
      severity: 'urgent',
    }]);
    const result = verifyLayer1(draft, new Set());  // empty validIds — rule: still passes

    expect(result.pass).toBe(true);
  });

  // D9: citations from PRIOR turns must be rejected
  it('rejects citation IDs from prior turns (D9 — this-turn-only scoping)', () => {
    // Tool results from prior turn are NOT in validIds (this-turn set).
    // Even if the prior row looks structurally valid, it must not be cited.
    const priorTurnId = 'tool:get_medications:row-0';
    const currentValidIds = new Set<string>([
      'tool:get_vitals:row-0',  // only vitals from this turn
      // get_medications NOT included — it was a prior-turn call
    ]);

    const draft  = buildAnswer([{ citation_ids: [priorTurnId] }]);
    const result = verifyLayer1(draft, currentValidIds);

    expect(result.pass).toBe(false);
    if (!result.pass) {
      expect(result.critique).toContain(priorTurnId);
    }
  });

  it('returns reject and lists ALL invalid IDs in the critique', () => {
    const draft = buildAnswer([{
      citation_ids: [
        'tool:get_medications:row-0',   // valid
        'tool:nonexistent:row-42',       // invalid
        'tool:also_fake:row-7',          // invalid
      ],
    }]);
    const result = verifyLayer1(draft, validIds);

    expect(result.pass).toBe(false);
    if (!result.pass) {
      expect(result.critique).toContain('tool:nonexistent:row-42');
      expect(result.critique).toContain('tool:also_fake:row-7');
    }
  });

  it('returns pass with multiple valid claims each citing different valid rows', () => {
    const draft = buildAnswer([
      { citation_ids: ['tool:get_medications:row-0'] },
      { citation_ids: ['tool:get_vitals:row-0'] },
      { citation_ids: ['tool:get_medications:row-0', 'tool:get_recent_labs:row-0'] },
    ]);
    const result = verifyLayer1(draft, validIds);

    expect(result.pass).toBe(true);
  });

  it('returns pass for an answer with no claims (empty claims array)', () => {
    const draft: Answer = {
      summary: 'No information available.',
      claims: [],
      conflicts: [],
      data_gaps: [],
      assumptions: [],
      evidence_catalog: [],
      followup_suggestions: [],
      confidence: 'low',
    };
    const result = verifyLayer1(draft, validIds);

    expect(result.pass).toBe(true);
  });

  it('handles a mix of valid tool: and valid rule: IDs in one claim', () => {
    const draft = buildAnswer([{
      citation_ids: [
        'tool:get_medications:row-1',
        'rule:ddi:warfarin-ibuprofen',
      ],
      severity: 'urgent',
    }]);
    const result = verifyLayer1(draft, validIds);

    expect(result.pass).toBe(true);
  });

  it('includes critique text pointing at "this turn" to guide the planner retry', () => {
    const draft  = buildAnswer([{ citation_ids: ['tool:fake:row-0'] }]);
    const result = verifyLayer1(draft, validIds);

    expect(result.pass).toBe(false);
    if (!result.pass) {
      // Critique should help the planner understand it must use current-turn rows
      expect(result.critique.toLowerCase()).toMatch(/this turn|current turn|tool results/i);
    }
  });

  // doc:* AgentForge source-document attribution. Like rule:*, these IDs
  // bypass the row-grounding check — the actual data is grounded via the
  // accompanying tool:* citation, doc:* is a UI-only label that the
  // citation pill renders as "lab pdf #N" / "intake form #N".
  it('exempts doc:lab-<id> citation IDs from the validIds check', () => {
    const draft = buildAnswer([{
      citation_ids: ['doc:lab-449'],
      severity: 'info',
    }]);
    const result = verifyLayer1(draft, new Set());

    expect(result.pass).toBe(true);
  });

  it('exempts doc:intake-<id> citation IDs from the validIds check', () => {
    const draft = buildAnswer([{
      citation_ids: ['doc:intake-12'],
      severity: 'info',
    }]);
    const result = verifyLayer1(draft, new Set());

    expect(result.pass).toBe(true);
  });

  it('passes a mixed claim (grounded tool:* + doc:* attribution)', () => {
    const draft = buildAnswer([{
      citation_ids: ['tool:get_recent_labs:row-0', 'doc:lab-449'],
      severity: 'info',
    }]);
    const result = verifyLayer1(draft, validIds);

    expect(result.pass).toBe(true);
  });

  it('rejects a mixed claim where the tool:* part is ungrounded, even if doc:* is present', () => {
    const draft = buildAnswer([{
      citation_ids: ['tool:get_recent_labs:row-99', 'doc:lab-449'],
      severity: 'info',
    }]);
    const result = verifyLayer1(draft, validIds);

    expect(result.pass).toBe(false);
    if (!result.pass) {
      expect(result.critique).toContain('tool:get_recent_labs:row-99');
    }
  });
});
