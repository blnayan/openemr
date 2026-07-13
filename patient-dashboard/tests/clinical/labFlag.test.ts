import { describe, expect, it } from 'vitest';

import { interpretLabFlag, type LabFlag } from '../../src/clinical/labFlag';

/**
 * Table-driven coverage of every interpretation-code input the dashboard
 * cares about, including missing and unknown codes. Adding a new
 * HL7 ObservationInterpretation code upstream should require a new row
 * here — that's the point: a single source of truth for the design's
 * lab-flag bucket mapping.
 */

interface Row {
  codes: readonly string[];
  expected: LabFlag;
  reason: string;
}

const ROWS: Row[] = [
  // Directional high
  { codes: ['H'], expected: 'high', reason: 'H → high' },
  { codes: ['HH'], expected: 'high', reason: 'HH (critical high) → high' },

  // Directional low
  { codes: ['L'], expected: 'low', reason: 'L → low' },
  { codes: ['LL'], expected: 'low', reason: 'LL (critical low) → low' },

  // Directionless abnormal
  { codes: ['A'], expected: 'abnormal', reason: 'A → abnormal' },
  { codes: ['AA'], expected: 'abnormal', reason: 'AA → abnormal' },

  // Normal / missing / unknown — all collapse to 'normal' (no flag)
  { codes: ['N'], expected: 'normal', reason: 'N → normal' },
  { codes: [], expected: 'normal', reason: 'no codes (absent interpretation) → normal' },
  { codes: ['B'], expected: 'normal', reason: 'unknown code "B" (better) → normal (safe default)' },
  { codes: ['totally-unknown'], expected: 'normal', reason: 'unrecognized code → normal' },
  { codes: [''], expected: 'normal', reason: 'empty code string → normal' },

  // Multi-code priority: directional outranks directionless
  { codes: ['A', 'H'], expected: 'high', reason: 'H beats A in same set' },
  { codes: ['H', 'A'], expected: 'high', reason: 'order-independent: H beats A' },
  { codes: ['A', 'L'], expected: 'low', reason: 'L beats A' },
  { codes: ['N', 'H'], expected: 'high', reason: 'H beats N' },
  { codes: ['N', 'A'], expected: 'abnormal', reason: 'A beats N' },

  // High vs low — first directional bucket in priority wins (high > low)
  // FHIR rarely emits both, but spec-wise we must pick deterministically.
  { codes: ['H', 'L'], expected: 'high', reason: 'high outranks low when both present' },
];

describe('interpretLabFlag (table-driven)', () => {
  for (const row of ROWS) {
    const codeLabel = row.codes.length === 0 ? '(none)' : row.codes.join(',');
    it(`${codeLabel} → ${row.expected} (${row.reason})`, () => {
      expect(interpretLabFlag(row.codes)).toBe(row.expected);
    });
  }
});

describe('interpretLabFlag rule priority', () => {
  it('high (H/HH) outranks low, abnormal, and normal', () => {
    for (const other of ['L', 'LL', 'A', 'AA', 'N', '', 'unknown']) {
      expect(interpretLabFlag(['H', other])).toBe('high');
      expect(interpretLabFlag(['HH', other])).toBe('high');
    }
  });

  it('low (L/LL) outranks abnormal and normal', () => {
    for (const other of ['A', 'AA', 'N', '', 'unknown']) {
      expect(interpretLabFlag(['L', other])).toBe('low');
      expect(interpretLabFlag(['LL', other])).toBe('low');
    }
  });

  it('abnormal (A/AA) outranks normal', () => {
    for (const other of ['N', '', 'unknown']) {
      expect(interpretLabFlag(['A', other])).toBe('abnormal');
    }
  });

  it('all-unknown / all-normal degrades to normal', () => {
    expect(interpretLabFlag(['N'])).toBe('normal');
    expect(interpretLabFlag([])).toBe('normal');
    expect(interpretLabFlag(['unknown', 'also-bogus'])).toBe('normal');
  });
});
