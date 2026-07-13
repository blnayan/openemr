/**
 * guidelineVerifier unit tests — substring pass/fail semantics for the
 * fail-closed guideline-citation verifier (W2_PRD §"Synthesis at the
 * supervisor level").
 */

import { describe, it, expect } from 'vitest';
import {
  isSubstringNormalized,
  verifyGuidelineCitations,
} from '../../../src/verification/guidelineVerifier.js';
import type { Claim, Citation } from '../../../src/schemas/AnswerSchema.js';
import type { RankedChunk } from '../../../src/retrieval/types.js';

const CHUNK: RankedChunk = {
  id: 'ada-2026-6.3a',
  source: 'ADA Standards of Care in Diabetes—2026',
  section_id: '6.3a',
  page: 132,
  body: 'An A1C goal of <7% (<53 mmol/mol) is appropriate for many nonpregnant adults without severe hypoglycemia or hypoglycemia affecting health or quality of life.',
  score: 0.91,
};

function guideline(quoted: string, chunkId = CHUNK.id): Citation {
  return {
    type: 'guideline',
    chunk_id: chunkId,
    source: CHUNK.source,
    section_id: CHUNK.section_id,
    quoted_span: quoted,
  };
}

function claim(text: string, citations: Citation[]): Claim {
  return {
    text,
    citation_ids: ['rule:guideline:ada-2026-6.3a'],
    citations,
    severity: 'info',
  };
}

describe('isSubstringNormalized', () => {
  it('returns true for an exact substring', () => {
    expect(isSubstringNormalized('An A1C goal of <7%', CHUNK.body)).toBe(true);
  });

  it('returns true after collapsing whitespace runs', () => {
    expect(
      isSubstringNormalized('An  A1C\tgoal\nof <7%', CHUNK.body),
    ).toBe(true);
  });

  it('returns true when haystack has whitespace runs', () => {
    const messyBody = 'An  A1C   goal\nof <7%';
    expect(isSubstringNormalized('An A1C goal of <7%', messyBody)).toBe(true);
  });

  it('returns false for a paraphrase that is not a substring', () => {
    expect(
      isSubstringNormalized('An A1C target below seven percent', CHUNK.body),
    ).toBe(false);
  });

  it('returns false for an empty needle', () => {
    expect(isSubstringNormalized('', CHUNK.body)).toBe(false);
  });

  it('returns false when the needle is not in the haystack', () => {
    expect(isSubstringNormalized('blood pressure goal', CHUNK.body)).toBe(false);
  });
});

describe('verifyGuidelineCitations', () => {
  it('keeps a claim whose guideline quote is a verbatim substring', () => {
    const c = claim(
      'ADA targets A1C <7% for many adults.',
      [guideline('An A1C goal of <7%')],
    );
    const result = verifyGuidelineCitations([c], [CHUNK]);
    expect(result.kept).toEqual([c]);
    expect(result.dropped).toEqual([]);
  });

  it('keeps a claim with whitespace-collapsed quote', () => {
    const c = claim(
      'ADA A1C target.',
      [guideline('An A1C\n  goal of  <7%')],
    );
    const result = verifyGuidelineCitations([c], [CHUNK]);
    expect(result.kept.length).toBe(1);
    expect(result.dropped.length).toBe(0);
  });

  it('drops a claim whose quote is a paraphrase', () => {
    const c = claim('ADA A1C target.', [guideline('A1C below seven percent')]);
    const result = verifyGuidelineCitations([c], [CHUNK]);
    expect(result.kept.length).toBe(0);
    expect(result.dropped.length).toBe(1);
    expect(result.dropped[0]?.reason.kind).toBe('quote_not_substring');
  });

  it('drops a claim whose chunk_id is unknown', () => {
    const c = claim('ADA target.', [guideline('An A1C goal of <7%', 'unknown-chunk')]);
    const result = verifyGuidelineCitations([c], [CHUNK]);
    expect(result.kept.length).toBe(0);
    expect(result.dropped[0]?.reason.kind).toBe('unknown_chunk');
  });

  it('passes through claims with no guideline citations', () => {
    const c: Claim = {
      text: 'patient claim',
      citation_ids: ['tool:get_labs:row-0'],
      severity: 'info',
    };
    const result = verifyGuidelineCitations([c], [CHUNK]);
    expect(result.kept).toEqual([c]);
  });

  it('drops every claim → kept is empty (refusal trigger)', () => {
    const c1 = claim('A', [guideline('paraphrase one')]);
    const c2 = claim('B', [guideline('paraphrase two')]);
    const result = verifyGuidelineCitations([c1, c2], [CHUNK]);
    expect(result.kept.length).toBe(0);
    expect(result.dropped.length).toBe(2);
  });

  it('drops a claim if any one of its guideline citations fails', () => {
    const c = claim('mixed', [
      guideline('An A1C goal of <7%'),         // valid
      guideline('not in the chunk at all'),    // invalid
    ]);
    const result = verifyGuidelineCitations([c], [CHUNK]);
    expect(result.kept.length).toBe(0);
    expect(result.dropped.length).toBe(1);
  });

  it('preserves claim order in the kept array', () => {
    const a = claim('A', [guideline('An A1C goal of <7%')]);
    const b = claim('B', [guideline('paraphrase')]);
    const c = claim('C', [guideline('many nonpregnant adults')]);
    const result = verifyGuidelineCitations([a, b, c], [CHUNK]);
    expect(result.kept.map(k => k.text)).toEqual(['A', 'C']);
  });
});
