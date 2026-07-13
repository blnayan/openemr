/**
 * factuallyConsistent rubric tests — exercises the substring check
 * across all three citation surfaces.
 */

import { describe, it, expect } from 'vitest';
// @ts-expect-error — .mjs rubric is intentionally untyped for evals harness
import factuallyConsistent from '../../../evals/rubrics/factuallyConsistent.js';

const CHUNK_ID = 'fixture::ch-09::9.7::0';
const CHUNK_BODY =
  'In adults with type 2 diabetes and established or high risk of atherosclerotic cardiovascular disease, the treatment plan should include medications with demonstrated benefits to reduce cardiovascular events.';

const chunks = { [CHUNK_ID]: CHUNK_BODY };

function answer(claims: any[]) {
  return {
    summary: 's',
    claims,
    followup_suggestions: [],
    confidence: 'high',
  };
}

describe('factuallyConsistent rubric — guideline citations', () => {
  it('passes when quoted_span is a substring of chunk body', async () => {
    const r = await factuallyConsistent(answer([{
      text: 'GLP-1 RA recommended for ASCVD.',
      citation_ids: ['rule:guideline:9.7'],
      citations: [{
        type: 'guideline',
        chunk_id: CHUNK_ID,
        source: 'fixture',
        section_id: '9.7',
        quoted_span: 'medications with demonstrated benefits to reduce cardiovascular events',
      }],
      severity: 'info',
    }]), { vars: { chunks } });
    expect(r.pass).toBe(true);
  });

  it('passes after whitespace normalization', async () => {
    const r = await factuallyConsistent(answer([{
      text: 't',
      citation_ids: ['rule:guideline:9.7'],
      citations: [{
        type: 'guideline',
        chunk_id: CHUNK_ID,
        source: 'fixture',
        section_id: '9.7',
        quoted_span: 'medications  with\tdemonstrated\nbenefits',
      }],
      severity: 'info',
    }]), { vars: { chunks } });
    expect(r.pass).toBe(true);
  });

  it('fails when quoted_span is a paraphrase, not a substring', async () => {
    const r = await factuallyConsistent(answer([{
      text: 't',
      citation_ids: ['rule:guideline:9.7'],
      citations: [{
        type: 'guideline',
        chunk_id: CHUNK_ID,
        source: 'fixture',
        section_id: '9.7',
        quoted_span: 'GLP-1 RA is the only first-line option',
      }],
      severity: 'info',
    }]), { vars: { chunks } });
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/quoted_span not a substring/);
  });

  it('fails when chunk_id is unknown', async () => {
    const r = await factuallyConsistent(answer([{
      text: 't',
      citation_ids: ['rule:guideline:bogus'],
      citations: [{
        type: 'guideline',
        chunk_id: 'unknown-chunk-id',
        source: 'fixture',
        section_id: '9.7',
        quoted_span: 'whatever',
      }],
      severity: 'info',
    }]), { vars: { chunks } });
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/unknown chunk_id/);
  });
});

describe('factuallyConsistent rubric — patient_record citations', () => {
  it('passes through patient_record citations unverified', async () => {
    const r = await factuallyConsistent(answer([{
      text: 'On metformin.',
      citation_ids: ['tool:get_medications:row-1'],
      citations: [{
        type: 'patient_record',
        citation_id: 'tool:get_medications:row-1',
      }],
      severity: 'info',
    }]), { vars: { chunks } });
    expect(r.pass).toBe(true);
  });
});

describe('factuallyConsistent rubric — patient_document citations', () => {
  it('passes through when no patient_documents stub is provided', async () => {
    const r = await factuallyConsistent(answer([{
      text: 'A1c 7.2%.',
      citation_ids: ['rule:guideline:x'],
      citations: [{
        type: 'patient_document',
        extraction_id: 'extract-1',
        bbox: { page: 1, x: 10, y: 10, w: 50, h: 20, image_w: 800, image_h: 1000 },
        citation_confidence: 0.9,
      }],
      severity: 'info',
    }]), { vars: { chunks } });
    expect(r.pass).toBe(true);
  });

  it('fails when stub does not contain the cited extraction', async () => {
    const r = await factuallyConsistent(answer([{
      text: 'A1c 7.2%.',
      citation_ids: ['rule:guideline:x'],
      citations: [{
        type: 'patient_document',
        extraction_id: 'extract-missing',
        bbox: { page: 1, x: 10, y: 10, w: 50, h: 20, image_w: 800, image_h: 1000 },
        citation_confidence: 0.9,
      }],
      severity: 'info',
    }]), { vars: { chunks, patient_documents: { 'extract-1': {} } } });
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/unknown extraction_id/);
  });
});

describe('factuallyConsistent rubric — empty/no-citation paths', () => {
  it('passes when there are no claims', async () => {
    const r = await factuallyConsistent(answer([]), { vars: { chunks } });
    expect(r.pass).toBe(true);
  });

  it('passes when claim has no rich citations to verify', async () => {
    const r = await factuallyConsistent(answer([{
      text: 't',
      citation_ids: ['tool:get_medications:row-1'],
      severity: 'info',
    }]), { vars: { chunks } });
    expect(r.pass).toBe(true);
  });
});
