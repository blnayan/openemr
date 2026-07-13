/**
 * AnswerSchema unit tests
 *
 * Validates the Zod schema contract for the structured output format.
 * Every claim must have at least one citation_id. Citation IDs must match
 * the regex for tool rows or rule findings.
 *
 * D9: Only this-turn tool-result rows count as valid citation sources.
 * The schema itself enforces ID format; the verifier enforces existence.
 *
 * Plan reference: §3.4, §5.3 AnswerSchema.test.ts, M3
 */

import { describe, it, expect } from 'vitest';
import { AnswerSchema, ClaimSchema, sanitizeAnswerInput } from '../../../src/schemas/AnswerSchema.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validAnswer() {
  return {
    summary:    'Maria is on warfarin and lisinopril.',
    claims:     [
      {
        text:         'Maria is on warfarin 5 mg daily.',
        citation_ids: ['tool:get_medications:row-0'],
        severity:     'info',
      },
    ],
    followup_suggestions: ['Ask about recent INR levels.'],
    confidence: 'high',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AnswerSchema', () => {
  it('accepts a valid answer with correct citation IDs', () => {
    const result = AnswerSchema.safeParse(validAnswer());
    expect(result.success).toBe(true);
  });

  it('accepts multiple claims with mixed severity levels', () => {
    const answer = {
      ...validAnswer(),
      claims: [
        { text: 'A', citation_ids: ['tool:get_vitals:row-0'], severity: 'info' },
        { text: 'B', citation_ids: ['tool:get_labs:row-1'], severity: 'attention' },
        { text: 'C', citation_ids: ['rule:ddi:warfarin-ibuprofen'], severity: 'urgent' },
      ],
    };
    expect(AnswerSchema.safeParse(answer).success).toBe(true);
  });

  // §3.4: "claims: z.array(ClaimSchema)" — must accept rule:* citation IDs
  it('accepts rule:* citation IDs injected by Layer 2 verifier', () => {
    const answer = {
      ...validAnswer(),
      claims: [
        {
          text:         'Warfarin + ibuprofen: major interaction.',
          citation_ids: ['rule:ddi:warfarin-ibuprofen'],
          severity:     'urgent',
        },
      ],
    };
    expect(AnswerSchema.safeParse(answer).success).toBe(true);
  });

  // §3.4: "citation_ids: z.array(CitationIdSchema).min(1)"
  it('rejects a claim with empty citation_ids array', () => {
    const answer = {
      ...validAnswer(),
      claims: [{ text: 'Uncited claim.', citation_ids: [], severity: 'info' }],
    };
    const result = AnswerSchema.safeParse(answer);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.path.includes('citation_ids'))).toBe(true);
    }
  });

  // §3.4: "severity: z.enum(['info','attention','urgent'])"
  it('rejects unknown severity values', () => {
    const answer = {
      ...validAnswer(),
      claims: [{ text: 'Bad claim.', citation_ids: ['tool:get_medications:row-0'], severity: 'critical' }],
    };
    expect(AnswerSchema.safeParse(answer).success).toBe(false);
  });

  it('rejects a citation ID that does not match the expected pattern', () => {
    const claim = {
      text: 'Bad citation.',
      citation_ids: ['freeform-id-without-namespace'],
      severity: 'info',
    };
    expect(ClaimSchema.safeParse(claim).success).toBe(false);
  });

  it('rejects an empty summary', () => {
    const answer = { ...validAnswer(), summary: '' };
    expect(AnswerSchema.safeParse(answer).success).toBe(false);
  });

  it('rejects summary exceeding 1000 chars', () => {
    const answer = { ...validAnswer(), summary: 'x'.repeat(1001) };
    expect(AnswerSchema.safeParse(answer).success).toBe(false);
  });

  it('rejects claim text exceeding 500 chars', () => {
    const claim = {
      text: 'x'.repeat(501),
      citation_ids: ['tool:get_medications:row-0'],
      severity: 'info',
    };
    expect(ClaimSchema.safeParse(claim).success).toBe(false);
  });

  it('rejects more than 3 followup_suggestions', () => {
    const answer = {
      ...validAnswer(),
      followup_suggestions: ['a', 'b', 'c', 'd'],  // max is 3
    };
    expect(AnswerSchema.safeParse(answer).success).toBe(false);
  });

  it('accepts 0 followup_suggestions', () => {
    const answer = { ...validAnswer(), followup_suggestions: [] };
    expect(AnswerSchema.safeParse(answer).success).toBe(true);
  });

  it('rejects missing confidence field', () => {
    const { confidence: _, ...answer } = validAnswer() as Record<string, unknown>;
    expect(AnswerSchema.safeParse(answer).success).toBe(false);
  });

  it('rejects invalid confidence value', () => {
    const answer = { ...validAnswer(), confidence: 'very-high' };
    expect(AnswerSchema.safeParse(answer).success).toBe(false);
  });

  it('accepts the tool:get_patient_summary:row-0 citation ID format', () => {
    const claim = {
      text: 'Patient summary.',
      citation_ids: ['tool:get_patient_summary:row-0'],
      severity: 'info',
    };
    expect(ClaimSchema.safeParse(claim).success).toBe(true);
  });

  it('accepts doc:lab-<id> source-document citation IDs', () => {
    const claim = {
      text: 'Cholesterol total 232 mg/dL on the uploaded lab.',
      citation_ids: ['tool:get_recent_labs:row-0', 'doc:lab-449'],
      severity: 'info',
    };
    expect(ClaimSchema.safeParse(claim).success).toBe(true);
  });

  it('accepts doc:intake-<id> source-document citation IDs', () => {
    const claim = {
      text: 'Patient self-reports metformin on the intake form.',
      citation_ids: ['doc:intake-77'],
      severity: 'info',
    };
    expect(ClaimSchema.safeParse(claim).success).toBe(true);
  });

  it('rejects doc:* citations with unknown kinds (only lab and intake allowed)', () => {
    const claim = {
      text: 'bad citation',
      citation_ids: ['doc:imaging-12'],
      severity: 'info',
    };
    expect(ClaimSchema.safeParse(claim).success).toBe(false);
  });

  it('accepts multi-digit row numbers in tool citation IDs', () => {
    const claim = {
      text: 'Something about row 999.',
      citation_ids: ['tool:get_recent_labs:row-999'],
      severity: 'info',
    };
    expect(ClaimSchema.safeParse(claim).success).toBe(true);
  });

  // The retriever returns chunk ids of the form
  // "<corpus>::ch-<chapter>::<section>::<index>" (e.g.
  // "ada-standards-of-care-in-diabetes-2026::ch-13::13.7a::0"), and the
  // synthesizer reuses the chunk_id verbatim as the rule:guideline:<slug>.
  // Regression for sanitizer dropping every guideline claim because `:`
  // was missing from the slug character class.
  it('accepts rule:guideline:<slug> with chunk-id-style "::" separators', () => {
    const claim = {
      text: 'Section 13.7a guideline target.',
      citation_ids: ['rule:guideline:ada-standards-of-care-in-diabetes-2026::ch-13::13.7a::0'],
      severity: 'info',
    };
    expect(ClaimSchema.safeParse(claim).success).toBe(true);
  });

  // Hyphenated categories (`no-data`, `no-interaction`) are an existing
  // AgentForge convention. The supervisor's verifier emits
  // `rule:no-data:supervisor-verifier` when it drops unverified claims,
  // and the DDI rubric expects `rule:no-data:check_drug_interactions`.
  // Regression for the pre-2026-05-10 regex `[a-z]+` rejecting them.
  it.each([
    ['rule:no-data:supervisor-verifier'],
    ['rule:no-data:check_drug_interactions'],
    ['rule:no-interaction:lisinopril-metformin'],
  ])('accepts hyphenated rule category: %s', (citationId) => {
    const claim = {
      text: 'Hyphenated category claim.',
      citation_ids: [citationId],
      severity: 'info',
    };
    expect(ClaimSchema.safeParse(claim).success).toBe(true);
  });

  it('rejects citation IDs with spaces', () => {
    const claim = {
      text: 'Claim.',
      citation_ids: ['tool: get medications:row-0'],
      severity: 'info',
    };
    expect(ClaimSchema.safeParse(claim).success).toBe(false);
  });

  // Round-trip canonical example
  it('round-trips a canonical answer through parse without data loss', () => {
    const answer = validAnswer();
    const parsed  = AnswerSchema.parse(answer);
    expect(parsed.summary).toBe(answer.summary);
    expect(parsed.claims[0]!.citation_ids[0]).toBe('tool:get_medications:row-0');
    expect(parsed.confidence).toBe('high');
  });
});

describe('sanitizeAnswerInput — runtime LLM-output coercion', () => {
  function base(): Record<string, unknown> {
    return {
      summary: 'Summary.',
      claims: [{
        text: 'Cited.',
        citation_ids: ['tool:get_medications:row-0'],
        severity: 'info',
      }],
      followup_suggestions: ['Ask about INR.'],
      confidence: 'high',
    };
  }

  it('defaults missing followup_suggestions to []', () => {
    const { followup_suggestions: _, ...without } = base();
    const out = AnswerSchema.parse(sanitizeAnswerInput(without));
    expect(out.followup_suggestions).toEqual([]);
  });

  it('clips more than 3 followup_suggestions and truncates to 150 chars', () => {
    const long = 'x'.repeat(200);
    const out = AnswerSchema.parse(sanitizeAnswerInput({
      ...base(),
      followup_suggestions: [long, 'b', 'c', 'd'],
    }));
    expect(out.followup_suggestions).toHaveLength(3);
    expect(out.followup_suggestions[0]).toHaveLength(150);
  });

  // Citation-shape drift recovery — tier-1 fix landed 2026-05-10.
  // The supervisor synthesizer's LLM occasionally emits
  // patient_document citations missing `citation_confidence` —
  // every other field present. Without the sanitizer, the whole
  // answer fails Zod validation, retries, fails again, and the
  // request surfaces as `agent_internal_error` to the client (this
  // was UC-2.1's failure mode in the eval suite). The sanitizer
  // fills in 0 — "unverifiable" — rather than dropping the claim.
  it('defaults missing citation_confidence on patient_document citations to 0', () => {
    const out = AnswerSchema.parse(sanitizeAnswerInput({
      ...base(),
      claims: [{
        text: 'Cited from intake form.',
        citation_ids: ['doc:intake-1'],
        severity: 'attention',
        citations: [{
          type: 'patient_document',
          extraction_id: 'extract-99',
          field_path: 'current_medications[0].name',
          bbox: { page: 0, x: 100, y: 50, w: 80, h: 12, image_w: 1000, image_h: 1400 },
          // citation_confidence intentionally absent — the synthesizer LLM
          // omits it on a fraction of claims.
        }],
      }],
    }));
    expect(out.claims).toHaveLength(1);
    const cit = (out.claims[0]?.citations ?? [])[0] as { type: string; citation_confidence: number };
    expect(cit?.type).toBe('patient_document');
    expect(cit?.citation_confidence).toBe(0);
  });

  it('does NOT touch citation_confidence when the LLM did supply it', () => {
    const out = AnswerSchema.parse(sanitizeAnswerInput({
      ...base(),
      claims: [{
        text: 'Cited.',
        citation_ids: ['doc:lab-1'],
        severity: 'info',
        citations: [{
          type: 'patient_document',
          extraction_id: 'extract-1',
          field_path: 'results[0].display_value',
          bbox: { page: 0, x: 0, y: 0, w: 10, h: 10, image_w: 100, image_h: 100 },
          citation_confidence: 0.85,
        }],
      }],
    }));
    const cit = (out.claims[0]?.citations ?? [])[0] as { citation_confidence: number };
    expect(cit?.citation_confidence).toBe(0.85);
  });

  it('does NOT default citation_confidence on guideline or patient_record citations', () => {
    // Those types don't carry the field at all — the sanitizer must
    // not accidentally inject it where it doesn't belong.
    const out = AnswerSchema.parse(sanitizeAnswerInput({
      ...base(),
      claims: [{
        text: 'Guideline-cited.',
        citation_ids: ['rule:guideline:ada-2026-6.3a'],
        severity: 'info',
        citations: [{
          type: 'guideline',
          chunk_id: 'ada-2026-6.3a',
          source: 'ADA Standards of Care 2026',
          section_id: '6.3a',
          quoted_span: 'A1c goal of <7%',
        }],
      }],
    }));
    const cit = (out.claims[0]?.citations ?? [])[0] as Record<string, unknown>;
    expect(cit?.['type']).toBe('guideline');
    expect('citation_confidence' in cit).toBe(false);
  });

  it('drops claims whose citation_ids are all non-canonical', () => {
    const out = AnswerSchema.parse(sanitizeAnswerInput({
      ...base(),
      claims: [
        { text: 'Bad.', citation_ids: ['general_knowledge'], severity: 'info' },
        { text: 'Good.', citation_ids: ['tool:get_medications:row-0'], severity: 'info' },
      ],
    }));
    expect(out.claims).toHaveLength(1);
    expect(out.claims[0]?.text).toBe('Good.');
  });

  it('keeps a claim and filters its citation_ids when only some are off-spec', () => {
    const out = AnswerSchema.parse(sanitizeAnswerInput({
      ...base(),
      claims: [{
        text: 'Mixed.',
        citation_ids: ['rule:Guideline:foo', 'tool:get_recent_labs:row-2'],
        severity: 'info',
      }],
    }));
    expect(out.claims[0]?.citation_ids).toEqual(['tool:get_recent_labs:row-2']);
  });
});
