import { describe, expect, it } from 'vitest';

import {
  dedupeCitationIds,
  resolveCitationChip,
} from '../../src/copilot/citationChip';

describe('resolveCitationChip', () => {
  // Table-driven over each prefix in the citation_id grammar.
  const cases: Array<{
    name: string;
    id: string;
    expected: { kind: 'clinical' | 'document'; label: string };
  }> = [
    {
      name: 'tool:medication_list maps to clinical Meds',
      id: 'tool:medication_list:row-3',
      expected: { kind: 'clinical', label: 'Meds' },
    },
    {
      name: 'tool:lab_results maps to clinical Labs',
      id: 'tool:lab_results:row-12',
      expected: { kind: 'clinical', label: 'Labs' },
    },
    {
      name: 'tool:get_recent_labs maps to clinical Labs',
      id: 'tool:get_recent_labs:row-0',
      expected: { kind: 'clinical', label: 'Labs' },
    },
    {
      name: 'tool:allergies maps to clinical Allergies',
      id: 'tool:allergies:row-1',
      expected: { kind: 'clinical', label: 'Allergies' },
    },
    {
      name: 'tool:problems maps to clinical Problems',
      id: 'tool:problems:row-2',
      expected: { kind: 'clinical', label: 'Problems' },
    },
    {
      name: 'tool:problem_list maps to clinical Problems',
      id: 'tool:problem_list:row-2',
      expected: { kind: 'clinical', label: 'Problems' },
    },
    {
      name: 'tool:care_team maps to clinical Care Team',
      id: 'tool:care_team:row-0',
      expected: { kind: 'clinical', label: 'Care Team' },
    },
    {
      name: 'tool:prescriptions maps to clinical Rx',
      id: 'tool:prescriptions:row-7',
      expected: { kind: 'clinical', label: 'Rx' },
    },
    {
      name: 'unknown tool: falls back to clinical Chart',
      id: 'tool:procedures:row-1',
      expected: { kind: 'clinical', label: 'Chart' },
    },
    {
      name: 'rule:* maps to clinical Guideline',
      id: 'rule:diabetes:6.3a',
      expected: { kind: 'clinical', label: 'Guideline' },
    },
    {
      name: 'rule with slashes still resolves to Guideline',
      id: 'rule:cardiology:section-3/subsection-2',
      expected: { kind: 'clinical', label: 'Guideline' },
    },
    {
      name: 'doc:lab-N maps to document Lab Doc',
      id: 'doc:lab-42',
      expected: { kind: 'document', label: 'Lab Doc' },
    },
    {
      name: 'doc:intake-N maps to document Intake',
      id: 'doc:intake-7',
      expected: { kind: 'document', label: 'Intake' },
    },
    {
      name: 'unknown doc: falls back to document Document',
      id: 'doc:other-1',
      expected: { kind: 'document', label: 'Document' },
    },
    {
      name: 'malformed id falls back to clinical Source',
      id: 'general_knowledge',
      expected: { kind: 'clinical', label: 'Source' },
    },
    {
      name: 'empty id falls back to clinical Source',
      id: '',
      expected: { kind: 'clinical', label: 'Source' },
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(resolveCitationChip(c.id)).toEqual(c.expected);
    });
  }
});

describe('dedupeCitationIds', () => {
  it('preserves first-seen order and removes duplicates', () => {
    const input = [
      'tool:lab_results:row-1',
      'tool:medication_list:row-2',
      'tool:lab_results:row-1',
      'rule:diabetes:6.3a',
      'tool:medication_list:row-2',
    ];
    const out = dedupeCitationIds(input);
    expect(out).toEqual([
      'tool:lab_results:row-1',
      'tool:medication_list:row-2',
      'rule:diabetes:6.3a',
    ]);
  });

  it('returns an empty array for an empty input', () => {
    expect(dedupeCitationIds([])).toEqual([]);
  });
});
