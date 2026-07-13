import { describe, it, expect } from 'vitest';
import { AnswerSchema } from '../../../src/schemas/AnswerSchema.js';

describe('AnswerSchema vNext fields', () => {
  it('parses payload with conflicts/data-gaps/assumptions/evidence catalog', () => {
    const parsed = AnswerSchema.safeParse({
      summary: 'Summary',
      claims: [{
        text: 'A1c 7.4% on latest lab.',
        severity: 'attention',
        finding_confidence: 'high',
        evidence_refs: ['ev_1'],
        citation_ids: ['tool:get_recent_labs:row-0'],
      }],
      data_gaps: [],
      assumptions: [],
      conflicts: [],
      evidence_catalog: [{
        id: 'ev_1',
        kind: 'chart_row',
        trust_level: 'primary_chart',
        label: 'Labs · A1c 7.4%',
        provenance_path: ['clinical_data', 'get_recent_labs'],
      }],
      confidence: 'medium',
      followup_suggestions: ['Show last three A1c values'],
    });
    expect(parsed.success).toBe(true);
  });

  it('keeps additive arrays optional via defaults', () => {
    const parsed = AnswerSchema.parse({
      summary: 'Summary',
      claims: [{
        text: 'LDL 132 mg/dL',
        severity: 'info',
        finding_confidence: 'medium',
        evidence_refs: ['ev_2'],
        citation_ids: ['tool:get_recent_labs:row-1'],
      }],
      confidence: 'low',
      followup_suggestions: [],
    });
    expect(parsed.conflicts).toEqual([]);
    expect(parsed.data_gaps).toEqual([]);
    expect(parsed.assumptions).toEqual([]);
    expect(parsed.evidence_catalog).toEqual([]);
  });
});

