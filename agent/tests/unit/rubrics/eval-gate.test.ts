/**
 * eval-gate aggregation tests — verify that the per-metric pass-rate
 * extractor correctly walks promptfoo's gradingResult.componentResults
 * shape, regardless of which top-level wrapper promptfoo emits.
 */

import { describe, it, expect } from 'vitest';
// @ts-expect-error — eval-gate is .mjs and intentionally untyped.
import { aggregatePassRates } from '../../../scripts/eval-gate.mjs';

function comp(metric: string, pass: boolean) {
  return { assertion: { metric }, pass };
}

function caseRow(metrics: Array<[string, boolean]>) {
  return {
    gradingResult: {
      componentResults: metrics.map(([m, p]) => comp(m, p)),
    },
  };
}

describe('eval-gate.aggregatePassRates', () => {
  it('aggregates pass rates per metric across cases', () => {
    const evalOutput = {
      results: {
        results: [
          caseRow([['schema_valid', true], ['citation_present', true]]),
          caseRow([['schema_valid', false], ['citation_present', true]]),
          caseRow([['schema_valid', true], ['citation_present', true]]),
        ],
      },
    };
    const rates = aggregatePassRates(evalOutput);
    expect(rates.schema_valid).toBeCloseTo((2 / 3) * 100, 5);
    expect(rates.citation_present).toBeCloseTo(100, 5);
  });

  it('handles the older top-level results array', () => {
    const evalOutput = {
      results: [caseRow([['safe_refusal', true], ['safe_refusal', false]])],
    };
    const rates = aggregatePassRates(evalOutput);
    expect(rates.safe_refusal).toBeCloseTo(50, 5);
  });

  it('returns an empty object for missing/empty results', () => {
    expect(aggregatePassRates({})).toEqual({});
    expect(aggregatePassRates({ results: { results: [] } })).toEqual({});
  });

  it('ignores assertions without a metric', () => {
    const evalOutput = {
      results: {
        results: [{
          gradingResult: {
            componentResults: [
              { assertion: {}, pass: true },
              { assertion: { metric: 'no_phi_in_logs' }, pass: true },
            ],
          },
        }],
      },
    };
    const rates = aggregatePassRates(evalOutput);
    expect(rates.no_phi_in_logs).toBeCloseTo(100, 5);
    expect(Object.keys(rates).length).toBe(1);
  });
});
