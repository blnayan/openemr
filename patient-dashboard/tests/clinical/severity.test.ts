import { describe, expect, it } from 'vitest';

import {
  interpretAllergySeverity,
  type AllergySeverityBucket,
} from '../../src/clinical/severity';

/**
 * Table-driven coverage of every `criticality × reactionSeverity` cell,
 * including missing values. Adding a new criticality or reaction severity
 * value upstream should require a new row here — that's the point: a single
 * source of truth for the design's severity bucket mapping.
 */

interface Row {
  criticality: string | null | undefined;
  reactionSeverity: string | null | undefined;
  expected: AllergySeverityBucket;
  reason: string;
}

const ROWS: Row[] = [
  // criticality === 'high' — always moderate (red), regardless of reaction
  { criticality: 'high', reactionSeverity: 'severe', expected: 'moderate', reason: 'high+severe → red' },
  { criticality: 'high', reactionSeverity: 'moderate', expected: 'moderate', reason: 'high+moderate → red' },
  { criticality: 'high', reactionSeverity: 'mild', expected: 'moderate', reason: 'high outranks mild reaction' },
  { criticality: 'high', reactionSeverity: undefined, expected: 'moderate', reason: 'high alone → red' },
  { criticality: 'high', reactionSeverity: null, expected: 'moderate', reason: 'high + null reaction → red' },

  // reaction.severity drives moderate (red) when criticality !== 'high'
  { criticality: 'low', reactionSeverity: 'severe', expected: 'moderate', reason: 'severe reaction outranks low criticality' },
  { criticality: 'unable-to-assess', reactionSeverity: 'severe', expected: 'moderate', reason: 'severe reaction outranks unable-to-assess' },
  { criticality: undefined, reactionSeverity: 'severe', expected: 'moderate', reason: 'severe reaction → red' },
  { criticality: undefined, reactionSeverity: 'moderate', expected: 'moderate', reason: 'moderate reaction → red' },
  { criticality: null, reactionSeverity: 'moderate', expected: 'moderate', reason: 'null criticality + moderate → red' },

  // criticality === 'low' → mild (amber)
  { criticality: 'low', reactionSeverity: 'mild', expected: 'mild', reason: 'low+mild → amber' },
  { criticality: 'low', reactionSeverity: undefined, expected: 'mild', reason: 'low alone → amber' },
  { criticality: 'low', reactionSeverity: null, expected: 'mild', reason: 'low + null reaction → amber' },

  // reaction.severity === 'mild' (without low criticality) → mild (amber)
  { criticality: undefined, reactionSeverity: 'mild', expected: 'mild', reason: 'mild reaction → amber' },
  { criticality: 'unable-to-assess', reactionSeverity: 'mild', expected: 'mild', reason: 'unable-to-assess + mild reaction → amber' },
  { criticality: null, reactionSeverity: 'mild', expected: 'mild', reason: 'null criticality + mild → amber' },

  // unknown bucket — missing data, unable-to-assess, or unrecognized values
  { criticality: undefined, reactionSeverity: undefined, expected: 'unknown', reason: 'no data → grey' },
  { criticality: null, reactionSeverity: null, expected: 'unknown', reason: 'all null → grey' },
  { criticality: 'unable-to-assess', reactionSeverity: undefined, expected: 'unknown', reason: 'unable-to-assess alone → grey' },
  { criticality: 'unable-to-assess', reactionSeverity: null, expected: 'unknown', reason: 'unable-to-assess + null reaction → grey' },
  { criticality: 'totally-unknown-value', reactionSeverity: 'also-bogus', expected: 'unknown', reason: 'unrecognized values → grey' },
  { criticality: '', reactionSeverity: '', expected: 'unknown', reason: 'empty strings → grey' },
];

describe('interpretAllergySeverity (table-driven)', () => {
  for (const row of ROWS) {
    const label = `${row.criticality ?? '∅'} × ${row.reactionSeverity ?? '∅'} → ${row.expected} (${row.reason})`;
    it(label, () => {
      expect(
        interpretAllergySeverity(row.criticality, row.reactionSeverity),
      ).toBe(row.expected);
    });
  }
});

describe('interpretAllergySeverity rule priority', () => {
  it('high criticality outranks every reaction severity', () => {
    for (const r of ['severe', 'moderate', 'mild', undefined, null]) {
      expect(interpretAllergySeverity('high', r)).toBe('moderate');
    }
  });

  it('severe/moderate reaction outranks low criticality', () => {
    expect(interpretAllergySeverity('low', 'severe')).toBe('moderate');
    expect(interpretAllergySeverity('low', 'moderate')).toBe('moderate');
  });

  it('low criticality outranks unknown reaction severity', () => {
    expect(interpretAllergySeverity('low', undefined)).toBe('mild');
    expect(interpretAllergySeverity('low', 'unrecognized')).toBe('mild');
  });
});
