import { describe, expect, it } from 'vitest';

import {
  applyEvent,
  emptyAnswer,
  parseSseEvent,
  type ParsedEvent,
} from '../../src/copilot/answerSchema';

describe('parseSseEvent', () => {
  it('parses a conversation event', () => {
    const ev = parseSseEvent(
      'conversation',
      JSON.stringify({
        conversation_id: '11111111-2222-3333-4444-555555555555',
        llm_driven: true,
        anchor: '2025-01-01',
        prior_message_count: 0,
      }),
    );
    expect(ev?.kind).toBe('conversation');
    if (ev?.kind === 'conversation') {
      expect(ev.payload.conversation_id).toBe(
        '11111111-2222-3333-4444-555555555555',
      );
    }
  });

  it('parses a summary event', () => {
    const ev = parseSseEvent('summary', JSON.stringify({ text: 'Hello.' }));
    expect(ev?.kind).toBe('summary');
    if (ev?.kind === 'summary') {
      expect(ev.payload.text).toBe('Hello.');
    }
  });

  it('parses a claim event with citation_ids and severity', () => {
    const ev = parseSseEvent(
      'claim',
      JSON.stringify({
        text: 'HbA1c trending down.',
        citation_ids: ['tool:lab_results:row-1'],
        severity: 'info',
      }),
    );
    expect(ev?.kind).toBe('claim');
    if (ev?.kind === 'claim') {
      expect(ev.payload.citation_ids).toEqual(['tool:lab_results:row-1']);
      expect(ev.payload.severity).toBe('info');
    }
  });

  it('parses a done event with empty data', () => {
    const ev = parseSseEvent('done', '{}');
    expect(ev?.kind).toBe('done');
  });

  it('parses an error event with reason', () => {
    const ev = parseSseEvent(
      'error',
      JSON.stringify({ reason: 'agent_internal_error' }),
    );
    expect(ev?.kind).toBe('error');
    if (ev?.kind === 'error') {
      expect(ev.payload.reason).toBe('agent_internal_error');
    }
  });

  it('returns null for malformed JSON', () => {
    expect(parseSseEvent('summary', '{not json')).toBeNull();
  });

  it('returns null for a structurally invalid claim', () => {
    // Missing required severity.
    expect(
      parseSseEvent(
        'claim',
        JSON.stringify({
          text: 'foo',
          citation_ids: ['tool:lab_results:row-1'],
        }),
      ),
    ).toBeNull();
  });

  it('falls back to unknown event kind for unrecognized event names', () => {
    const ev = parseSseEvent('not_a_real_event', JSON.stringify({ x: 1 }));
    expect(ev?.kind).toBe('unknown');
  });

  it('parses a section event into key + label', () => {
    const ev = parseSseEvent(
      'section',
      JSON.stringify({ key: 'actionItems', label: 'Action Items' }),
    );
    expect(ev?.kind).toBe('section');
    if (ev?.kind !== 'section') throw new Error('expected section');
    expect(ev.payload.key).toBe('actionItems');
    expect(ev.payload.label).toBe('Action Items');
  });

  it('rejects a section event missing the required label', () => {
    const ev = parseSseEvent('section', JSON.stringify({ key: 'foo' }));
    expect(ev).toBeNull();
  });

  it('parses evidence_catalog and confidence events', () => {
    const cat = parseSseEvent(
      'evidence_catalog',
      JSON.stringify({
        entries: [
          {
            kind: 'chart_row',
            id: 'ev_1',
            label: 'Labs · LDL 99',
            facet: 'clinical',
            legacy_pointer: 'tool:get_recent_labs:row-0',
            tool: 'get_recent_labs',
            row_index: 0,
            document_hint: null,
          },
        ],
      }),
    );
    expect(cat?.kind).toBe('evidence_catalog');

    const conf = parseSseEvent('confidence', JSON.stringify({ value: 'low' }));
    expect(conf?.kind).toBe('confidence');
    if (conf?.kind === 'confidence') {
      expect(conf.payload.value).toBe('low');
    }
  });

  it('parses claim event with evidence_refs', () => {
    const ev = parseSseEvent(
      'claim',
      JSON.stringify({
        text: 'x',
        citation_ids: ['tool:get_recent_labs:row-0'],
        evidence_refs: ['ev_1'],
        severity: 'info',
      }),
    );
    expect(ev?.kind).toBe('claim');
    if (ev?.kind === 'claim') {
      expect(ev.payload.evidence_refs).toEqual(['ev_1']);
    }
  });

  it('parses claim confidence and uncertainty fields', () => {
    const ev = parseSseEvent(
      'claim',
      JSON.stringify({
        text: 'x',
        citation_ids: ['tool:get_recent_labs:row-0'],
        severity: 'attention',
        finding_confidence: 'low',
        uncertainty_reason: 'Conflicting source values',
      }),
    );
    expect(ev?.kind).toBe('claim');
    if (ev?.kind === 'claim') {
      expect(ev.payload.finding_confidence).toBe('low');
      expect(ev.payload.uncertainty_reason).toBe('Conflicting source values');
    }
  });

  it('parses conflict, data_gap, and assumption events', () => {
    const conflict = parseSseEvent(
      'conflict',
      JSON.stringify({
        type: 'source_disagreement',
        message: 'Intake and med list disagree on metformin dose.',
        severity: 'attention',
        evidence_refs: ['ev_2'],
      }),
    );
    expect(conflict?.kind).toBe('conflict');

    const dataGap = parseSseEvent(
      'data_gap',
      JSON.stringify({
        message: 'No recent urine albumin/creatinine ratio found.',
        severity: 'attention',
        blocks: ['ckd_staging'],
      }),
    );
    expect(dataGap?.kind).toBe('data_gap');

    const assumption = parseSseEvent(
      'assumption',
      JSON.stringify({ message: 'Assuming patient is fasting for lipid panel.' }),
    );
    expect(assumption?.kind).toBe('assumption');
  });
});

describe('applyEvent — partial answer accumulation', () => {
  it('starts from an empty answer', () => {
    const a = emptyAnswer();
    expect(a.summary).toBe('');
    expect(a.claims).toEqual([]);
    expect(a.confidence).toBe('medium');
    expect(a.evidence_catalog).toEqual({});
    expect(a.data_gaps).toEqual([]);
    expect(a.assumptions).toEqual([]);
    expect(a.conflicts).toEqual([]);
    expect(a.section_labels).toEqual({});
  });

  it('accumulates section header frames into key→label map', () => {
    let a = emptyAnswer();
    a = applyEvent(a, {
      kind: 'section',
      payload: { key: 'actionItems', label: 'Action Items' },
    });
    a = applyEvent(a, {
      kind: 'section',
      payload: { key: 'activeProblems', label: 'Active Problems' },
    });
    expect(a.section_labels).toEqual({
      actionItems: 'Action Items',
      activeProblems: 'Active Problems',
    });
  });

  it('streams a complete answer end to end', () => {
    let a = emptyAnswer();
    const events: ParsedEvent[] = [
      {
        kind: 'conversation',
        payload: { conversation_id: 'abc' },
      },
      {
        kind: 'evidence_catalog',
        payload: {
          entries: [
            {
              kind: 'chart_row',
              id: 'ev_1',
              label: 'Labs · x',
              facet: 'clinical',
              legacy_pointer: 'tool:lab_results:row-1',
              tool: 'get_recent_labs',
              row_index: 1,
              document_hint: null,
            },
          ],
        },
      },
      { kind: 'summary', payload: { text: 'Patient is stable.' } },
      {
        kind: 'claim',
        payload: {
          text: 'A1c at goal.',
          citation_ids: ['tool:lab_results:row-1'],
          evidence_refs: ['ev_1'],
          severity: 'info',
        },
      },
      {
        kind: 'claim',
        payload: {
          text: 'Watch BP.',
          citation_ids: ['tool:lab_results:row-2', 'rule:diabetes:6.3a'],
          severity: 'attention',
        },
      },
      { kind: 'confidence', payload: { value: 'high' } },
      {
        kind: 'conflict',
        payload: {
          type: 'source_disagreement',
          message: 'Intake and chart disagree on metformin dose.',
          severity: 'attention',
          evidence_refs: ['ev_1'],
        },
      },
      {
        kind: 'data_gap',
        payload: {
          message: 'No recent urine albumin/creatinine ratio found.',
          severity: 'attention',
          blocks: ['ckd_staging'],
        },
      },
      {
        kind: 'assumption',
        payload: {
          message: 'Assuming the latest fasting glucose was fasting.',
        },
      },
      { kind: 'done', payload: {} },
    ];
    for (const ev of events) a = applyEvent(a, ev);
    expect(a.summary).toBe('Patient is stable.');
    expect(a.evidence_catalog['ev_1']?.label).toBe('Labs · x');
    expect(a.confidence).toBe('high');
    expect(a.claims).toHaveLength(2);
    expect(a.claims[1]?.citation_ids).toEqual([
      'tool:lab_results:row-2',
      'rule:diabetes:6.3a',
    ]);
    expect(a.conflicts).toHaveLength(1);
    expect(a.data_gaps).toHaveLength(1);
    expect(a.assumptions).toHaveLength(1);
  });

  it('produces a sensible mid-stream snapshot', () => {
    // Snapshot after only conversation + summary + first claim.
    let a = emptyAnswer();
    a = applyEvent(a, {
      kind: 'conversation',
      payload: { conversation_id: 'abc' },
    });
    a = applyEvent(a, {
      kind: 'summary',
      payload: { text: 'Streaming…' },
    });
    a = applyEvent(a, {
      kind: 'claim',
      payload: {
        text: 'first',
        citation_ids: ['tool:lab_results:row-1'],
        severity: 'info',
      },
    });
    expect(a.summary).toBe('Streaming…');
    expect(a.claims).toHaveLength(1);
  });
});
