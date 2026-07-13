/**
 * Evidence catalog materialization — labels and stable ev_n ids.
 */

import { describe, it, expect } from 'vitest';
import type { Answer } from '../../../src/schemas/AnswerSchema.js';
import {
  evidenceRefsForCitationIds,
  materializeEvidenceCatalogForAnswer,
} from '../../../src/streaming/evidenceCatalog.js';

describe('materializeEvidenceCatalogForAnswer', () => {
  const ANSWER_EXTRAS = {
    conflicts: [],
    data_gaps: [],
    assumptions: [],
    evidence_catalog: [],
  };

  it('assigns ev_1 … in first-seen citation order and maps pointers', () => {
    const answer: Answer = {
      summary: 'S',
      confidence: 'high',
      ...ANSWER_EXTRAS,
      followup_suggestions: [],
      claims: [
        {
          text: 'Lipid panel relevant.',
          citation_ids: ['tool:get_recent_labs:row-2', 'rule:diabetes:6.3a'],
          severity: 'info',
        },
        {
          text: 'Uses same lab row again.',
          citation_ids: ['tool:get_recent_labs:row-2'],
          severity: 'attention',
        },
      ],
    };

    const rows = [
      {
        id: 'tool:get_recent_labs:row-2',
        name: 'LDL-C',
        value: 142,
        unit: 'mg/dL',
        date: '2026-02-01',
      },
    ];

    const cat = materializeEvidenceCatalogForAnswer(answer, [
      { ok: true as const, tool: 'get_recent_labs', rows },
    ]);

    expect(cat.entries).toHaveLength(2);
    expect(cat.entries[0]?.id).toBe('ev_1');
    expect(cat.entries[1]?.id).toBe('ev_2');
    expect(cat.entries[0]?.kind).toBe('chart_row');
    expect(cat.entries[0]?.label).toContain('LDL');
    expect(cat.entries[1]?.kind).toBe('guideline');

    const labEv = cat.pointerToEvidenceId.get('tool:get_recent_labs:row-2');
    const ruleEv = cat.pointerToEvidenceId.get('rule:diabetes:6.3a');
    expect(labEv).toBe('ev_1');
    expect(ruleEv).toBe('ev_2');

    const r0 = evidenceRefsForCitationIds(answer.claims[0]!.citation_ids, cat.pointerToEvidenceId);
    expect(r0).toEqual(['ev_1', 'ev_2']);
    const r1 = evidenceRefsForCitationIds(answer.claims[1]!.citation_ids, cat.pointerToEvidenceId);
    expect(r1).toEqual(['ev_1']);
  });

  it('enriches guideline label from claim.citations when present', () => {
    const answer: Answer = {
      summary: 'S',
      confidence: 'medium',
      ...ANSWER_EXTRAS,
      followup_suggestions: [],
      claims: [
        {
          text: 'Per ADA.',
          citation_ids: ['rule:diabetes:7.1'],
          severity: 'info',
          citations: [
            {
              type: 'guideline',
              chunk_id: 'ada-2026-7.1',
              source: 'ADA Standards of Care in Diabetes—2026',
              section_id: '7.1',
              quoted_span: 'test span for verification',
            },
          ],
        },
      ],
    };

    const cat = materializeEvidenceCatalogForAnswer(answer, []);
    const g = cat.entries.find(e => e.kind === 'guideline');
    expect(g?.label).toContain('ADA');
    expect(g?.label).toContain('7.1');
    expect(g?.section_id).toBe('7.1');
  });
});
