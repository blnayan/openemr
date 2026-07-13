/**
 * Eval suite — EncounterDiff. Pure-function tests; no FHIR, no LLM.
 */

import { describe, it, expect } from 'vitest';
import { computeEncounterDiff, describeDiff, flattenDiff } from '../../src/clinical/EncounterDiff.js';
import {
  STABLE_NO_CHANGES, NEW_MEDICATION, NEW_ABNORMAL_LAB,
  DDI_PRESENT, ALLERGY_CONFLICT, FIRST_VISIT,
} from './fixtures.js';

describe('computeEncounterDiff', () => {
  it('STABLE_NO_CHANGES → no deltas, baseline=false', () => {
    const diff = computeEncounterDiff(STABLE_NO_CHANGES);
    expect(diff.baseline).toBe(false);
    expect(diff.newProblems).toHaveLength(0);
    expect(diff.medsAdded).toHaveLength(0);
    expect(diff.newAbnormalLabs).toHaveLength(0);
  });

  it('NEW_MEDICATION → exactly one medsAdded entry', () => {
    const diff = computeEncounterDiff(NEW_MEDICATION);
    expect(diff.medsAdded).toHaveLength(1);
    expect(diff.medsAdded[0]?.text.toLowerCase()).toContain('atorvastatin');
    expect(diff.medsAdded[0]?.citationIds).toContain('tool:get_medications:row-0');
  });

  it('NEW_ABNORMAL_LAB → exactly one newAbnormalLabs entry', () => {
    const diff = computeEncounterDiff(NEW_ABNORMAL_LAB);
    expect(diff.newAbnormalLabs).toHaveLength(1);
    expect(diff.newAbnormalLabs[0]?.severity).toBe('attention');
  });

  it('DDI_PRESENT (med added since last visit) → meds added detected', () => {
    const diff = computeEncounterDiff(DDI_PRESENT);
    // Ibuprofen started recently; warfarin started in 2020.
    expect(diff.medsAdded.some(m => /ibuprofen/i.test(m.text))).toBe(true);
  });

  it('ALLERGY_CONFLICT → med added detected', () => {
    const diff = computeEncounterDiff(ALLERGY_CONFLICT);
    expect(diff.medsAdded.some(m => /amoxicillin/i.test(m.text))).toBe(true);
  });

  it('FIRST_VISIT (one encounter) → baseline=true', () => {
    const diff = computeEncounterDiff(FIRST_VISIT);
    expect(diff.baseline).toBe(true);
  });

  it('describeDiff yields a baseline phrase when baseline=true', () => {
    const diff = computeEncounterDiff(FIRST_VISIT);
    const text = describeDiff(diff, 'Maria González');
    expect(text.toLowerCase()).toMatch(/no prior encounter|first.*visit/);
  });

  it('describeDiff names the deltas when changes exist', () => {
    const diff = computeEncounterDiff(NEW_MEDICATION);
    const text = describeDiff(diff, 'Maria González');
    expect(text.toLowerCase()).toContain('med add');
  });

  it('flattenDiff returns the union of all delta categories', () => {
    const diff = computeEncounterDiff(NEW_ABNORMAL_LAB);
    const items = flattenDiff(diff);
    expect(items.some(i => /creatinine/i.test(i.text))).toBe(true);
  });

  it('every delta item has a non-empty citationIds list', () => {
    for (const fixture of [STABLE_NO_CHANGES, NEW_MEDICATION, NEW_ABNORMAL_LAB, DDI_PRESENT, ALLERGY_CONFLICT]) {
      const items = flattenDiff(computeEncounterDiff(fixture));
      for (const item of items) {
        expect(item.citationIds.length).toBeGreaterThan(0);
      }
    }
  });
});
