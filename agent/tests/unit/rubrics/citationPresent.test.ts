/**
 * citationPresent rubric tests.
 */

import { describe, it, expect } from 'vitest';
// @ts-expect-error — .mjs rubric is intentionally untyped for evals harness
import citationPresent from '../../../evals/rubrics/citationPresent.js';

describe('citationPresent rubric', () => {
  it('passes when every claim carries at least one citation_id', async () => {
    const r = await citationPresent({
      summary: 's',
      claims: [
        { text: 't1', citation_ids: ['tool:get_medications:row-1'], severity: 'info' },
        { text: 't2', citation_ids: ['rule:guideline:x'], severity: 'info' },
      ],
      followup_suggestions: [],
      confidence: 'high',
    }, {});
    expect(r.pass).toBe(true);
  });

  it('passes when claim has rich citations but no citation_ids', async () => {
    const r = await citationPresent({
      summary: 's',
      claims: [
        {
          text: 't',
          citation_ids: [],
          citations: [{
            type: 'guideline',
            chunk_id: 'x',
            source: 'src',
            section_id: '1.1',
            quoted_span: 'q',
          }],
          severity: 'info',
        },
      ],
      followup_suggestions: [],
      confidence: 'high',
    }, {});
    expect(r.pass).toBe(true);
  });

  it('fails when any claim has zero citations', async () => {
    const r = await citationPresent({
      summary: 's',
      claims: [
        { text: 'okay', citation_ids: ['tool:get_medications:row-1'], severity: 'info' },
        { text: 'uncited', citation_ids: [], severity: 'info' },
      ],
      followup_suggestions: [],
      confidence: 'high',
    }, {});
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/uncited/);
  });

  it('passes for an empty claims array (refusal-shaped)', async () => {
    const r = await citationPresent({
      summary: 'No data',
      claims: [],
      followup_suggestions: [],
      confidence: 'low',
    }, {});
    expect(r.pass).toBe(true);
  });

  it('fails when output is unparseable', async () => {
    const r = await citationPresent('garbage', {});
    expect(r.pass).toBe(false);
  });
});
