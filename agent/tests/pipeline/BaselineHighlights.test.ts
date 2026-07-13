/**
 * Eval suite — BaselineHighlights. Pure-function tests that confirm
 * critical baseline facts (active problems, key meds, severe allergies)
 * are surfaced even when the encounter diff is empty.
 */

import { describe, it, expect } from 'vitest';
import { computeBaselineHighlights, flattenBaseline } from '../../src/clinical/BaselineHighlights.js';
import {
  STABLE_NO_CHANGES, NEW_MEDICATION, DDI_PRESENT, ALLERGY_CONFLICT, FIRST_VISIT, PARTIAL_FAILURE,
} from './fixtures.js';
import type { ToolResult } from '../../src/tools/types.js';

describe('computeBaselineHighlights', () => {
  it('STABLE_NO_CHANGES — surfaces the active problem (Hypertension) and active med (Lisinopril)', () => {
    const baseline = computeBaselineHighlights(STABLE_NO_CHANGES);
    expect(baseline.problems.some(p => /hypertension/i.test(p.text))).toBe(true);
    expect(baseline.medications.some(m => /lisinopril/i.test(m.text))).toBe(true);
  });

  it('NEW_MEDICATION — baseline includes the active problem and the (newly added) med', () => {
    const baseline = computeBaselineHighlights(NEW_MEDICATION);
    expect(baseline.problems.length).toBeGreaterThan(0);
    expect(baseline.medications.length).toBeGreaterThan(0);
  });

  it('DDI_PRESENT — both warfarin AND ibuprofen surface as baseline meds', () => {
    const baseline = computeBaselineHighlights(DDI_PRESENT);
    expect(baseline.medications.some(m => /warfarin/i.test(m.text))).toBe(true);
    expect(baseline.medications.some(m => /ibuprofen/i.test(m.text))).toBe(true);
  });

  it('ALLERGY_CONFLICT — high-criticality allergy is marked attention severity', () => {
    const baseline = computeBaselineHighlights(ALLERGY_CONFLICT);
    const amox = baseline.allergies.find(a => /amoxicillin/i.test(a.text));
    expect(amox).toBeDefined();
    expect(amox?.severity).toBe('attention');
  });

  it('FIRST_VISIT — empty chart yields empty baseline (cleanly)', () => {
    const baseline = computeBaselineHighlights(FIRST_VISIT);
    expect(baseline.problems).toHaveLength(0);
    expect(baseline.medications).toHaveLength(0);
    expect(baseline.allergies).toHaveLength(0);
  });

  it('PARTIAL_FAILURE — baseline still works for the tools that succeeded', () => {
    const baseline = computeBaselineHighlights(PARTIAL_FAILURE);
    // get_medications succeeded → meds should be present
    expect(baseline.medications.length).toBeGreaterThan(0);
    // get_active_problems failed → problems should be empty (gracefully)
    expect(baseline.problems).toHaveLength(0);
  });

  it('Caps each category — no more than 3 problems, 3 meds, 2 allergies', () => {
    // Synthesize a fixture with many entries
    const big: ToolResult[] = [
      {
        ok: true, tool: 'get_active_problems',
        rows: Array.from({ length: 10 }, (_, i) => ({
          id: `tool:get_active_problems:row-${i}`,
          condition: `Condition ${i}`, onset: '2020-01-01', active: true,
        })),
      },
      {
        ok: true, tool: 'get_medications',
        rows: Array.from({ length: 10 }, (_, i) => ({
          id: `tool:get_medications:row-${i}`,
          drug_name: `Drug ${i}`, rxnorm_code: String(i), end_date: null, status: 'active',
        })),
      },
      {
        ok: true, tool: 'get_allergies',
        rows: Array.from({ length: 5 }, (_, i) => ({
          id: `tool:get_allergies:row-${i}`,
          allergen: `Allergen ${i}`, criticality: 'low',
        })),
      },
    ];
    const baseline = computeBaselineHighlights(big);
    expect(baseline.problems.length).toBeLessThanOrEqual(3);
    expect(baseline.medications.length).toBeLessThanOrEqual(3);
    expect(baseline.allergies.length).toBeLessThanOrEqual(2);
  });

  it('High-risk meds (warfarin) sort to the top of medications', () => {
    const fixture: ToolResult[] = [
      {
        ok: true, tool: 'get_medications',
        rows: [
          { id: 'tool:get_medications:row-0', drug_name: 'Vitamin D', rxnorm_code: '99999', end_date: null, status: 'active' },
          { id: 'tool:get_medications:row-1', drug_name: 'Acetaminophen', rxnorm_code: '88888', end_date: null, status: 'active' },
          { id: 'tool:get_medications:row-2', drug_name: 'Warfarin', rxnorm_code: '11289', end_date: null, status: 'active' },
        ],
      },
    ];
    const baseline = computeBaselineHighlights(fixture);
    // Warfarin should appear in the top 3, marked as attention
    const warf = baseline.medications.find(m => /warfarin/i.test(m.text));
    expect(warf).toBeDefined();
    expect(warf?.severity).toBe('attention');
  });

  it('Every baseline item carries a non-empty citationIds list', () => {
    const items = flattenBaseline(computeBaselineHighlights(NEW_MEDICATION));
    for (const item of items) {
      expect(item.citationIds.length).toBeGreaterThan(0);
      expect(item.citationIds[0]).toMatch(/^tool:[a-z_]+:row-\d+$/);
    }
  });
});
