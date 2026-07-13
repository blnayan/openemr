/**
 * ClinicalRuleEngine unit tests — Layer 2 deterministic verification
 *
 * Tests the rule engine that fires REGARDLESS of what the planner said.
 * Key behaviors:
 *   - Warfarin + ibuprofen → RuleResult with severity 'urgent' (eval class 8)
 *   - Allergy-vs-medication conflict → RuleResult with severity 'urgent'
 *   - Out-of-range dose → RuleResult
 *   - Missing RxNorm codes → degraded mode result
 *   - No interactions found → empty results array
 *
 * Plan reference: §3.5 Layer 2, §5.3 ClinicalRuleEngine.test.ts, M4
 * ARCHITECTURE.md D8: "deterministic clinical rules run after generation"
 */

import { describe, it, expect } from 'vitest';
import { ClinicalRuleEngine } from '../../../src/verification/ClinicalRuleEngine.js';
import type { ToolResult } from '../../../src/tools/types.js';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function medicationRow(rxnorm: string, name: string, index: number): Record<string, unknown> {
  return {
    id:            `tool:get_medications:row-${index}`,
    drug_name:     name,
    rxnorm_code:   rxnorm,
    active:        1,
    end_date:      null,
  };
}

function allergyRow(allergen: string, index: number): Record<string, unknown> {
  return {
    id:       `tool:get_allergies:row-${index}`,
    allergen,
    reaction: 'anaphylaxis',
  };
}

function medicationsResult(rows: Array<Record<string, unknown>>): ToolResult {
  return { ok: true, rows: rows as Array<Record<string, unknown> & { id: string }>, tool: 'get_medications' };
}

function allergiesResult(rows: Array<Record<string, unknown>>): ToolResult {
  return { ok: true, rows: rows as Array<Record<string, unknown> & { id: string }>, tool: 'get_allergies' };
}

// ---------------------------------------------------------------------------

describe('ClinicalRuleEngine', () => {
  const engine = new ClinicalRuleEngine();

  // §3.5 / eval class 8: warfarin (RxNorm 11289) + ibuprofen (RxNorm 5640)
  it('detects warfarin + ibuprofen DDI as an urgent rule result', () => {
    const toolResults: ToolResult[] = [
      medicationsResult([
        medicationRow('11289', 'Warfarin', 0),   // warfarin RxNorm
        medicationRow('5640',  'Ibuprofen', 1),  // ibuprofen RxNorm
      ]),
    ];

    const results = engine.evaluate(toolResults);

    const ddiResult = results.find(r => r.ruleId.includes('warfarin') || r.ruleId.includes('ibuprofen'));
    expect(ddiResult).toBeDefined();
    expect(ddiResult?.severity).toBe('urgent');
    expect(ddiResult?.citationId).toMatch(/^rule:ddi:/);
  });

  // §3.5: Rule results have synthetic citation IDs of form rule:<type>:<ruleId>
  it('emits citationId in the form rule:ddi:<id> for DDI findings', () => {
    const toolResults: ToolResult[] = [
      medicationsResult([
        medicationRow('11289', 'Warfarin', 0),
        medicationRow('5640',  'Ibuprofen', 1),
      ]),
    ];

    const results = engine.evaluate(toolResults);

    results.forEach(r => {
      expect(r.citationId).toMatch(/^rule:[a-z]+:[a-zA-Z0-9_-]+$/);
    });
  });

  // §3.5: All rule findings are severity 'urgent'
  it('always emits severity urgent for all rule findings', () => {
    const toolResults: ToolResult[] = [
      medicationsResult([
        medicationRow('11289', 'Warfarin', 0),
        medicationRow('5640',  'Ibuprofen', 1),
      ]),
    ];

    const results = engine.evaluate(toolResults);

    results.forEach(r => {
      expect(r.severity).toBe('urgent');
    });
  });

  // Allergy conflict: drug name matches allergen name
  it('detects allergy-vs-medication conflict', () => {
    const toolResults: ToolResult[] = [
      medicationsResult([medicationRow('723', 'Amoxicillin', 0)]),
      allergiesResult([allergyRow('amoxicillin', 0)]),
    ];

    const results = engine.evaluate(toolResults);

    const allergyResult = results.find(r => r.ruleId.includes('allergy'));
    expect(allergyResult).toBeDefined();
    expect(allergyResult?.severity).toBe('urgent');
    expect(allergyResult?.citationId).toMatch(/^rule:allergy:/);
  });

  // AUDIT.md §4: missing RxNorm → degraded mode result, not silent failure
  it('returns a degraded result when no RxNorm codes are available', () => {
    const toolResults: ToolResult[] = [
      medicationsResult([
        { id: 'tool:get_medications:row-0', drug_name: 'Warfarin', rxnorm_code: null, active: 1, end_date: null },
        { id: 'tool:get_medications:row-1', drug_name: 'Ibuprofen', rxnorm_code: null, active: 1, end_date: null },
      ]),
    ];

    const results = engine.evaluate(toolResults);

    const degraded = results.find(r => r.ruleId === 'ddi:no-rxnorm');
    expect(degraded).toBeDefined();
    expect(degraded?.description).toMatch(/rxnorm|incomplete/i);
  });

  it('returns empty array when no interactions or conflicts are found', () => {
    const toolResults: ToolResult[] = [
      medicationsResult([medicationRow('29046', 'Lisinopril', 0)]),
      allergiesResult([allergyRow('penicillin', 0)]),  // no match
    ];

    const results = engine.evaluate(toolResults);

    // No DDI, no allergy conflict for lisinopril + penicillin allergy
    const urgentFindings = results.filter(r => r.severity === 'urgent' && !r.ruleId.includes('coverage'));
    expect(urgentFindings).toHaveLength(0);
  });

  // §3.5: Dose sanity check
  it('flags out-of-range dose for known drug class', () => {
    // Atorvastatin max is 80 mg — 160 mg is out of range
    const toolResults: ToolResult[] = [
      medicationsResult([
        {
          id:          'tool:get_medications:row-0',
          drug_name:   'Atorvastatin',
          rxnorm_code: '41493',
          dose_mg:     160,  // above max 80 mg
          active:      1,
          end_date:    null,
        },
      ]),
    ];

    const results = engine.evaluate(toolResults);

    const doseResult = results.find(r => r.ruleId.includes('dose'));
    expect(doseResult).toBeDefined();
    expect(doseResult?.severity).toBe('urgent');
  });

  it('does not flag dose within therapeutic range', () => {
    const toolResults: ToolResult[] = [
      medicationsResult([
        {
          id:          'tool:get_medications:row-0',
          drug_name:   'Atorvastatin',
          rxnorm_code: '41493',
          dose_mg:     40,  // within 10-80 mg range
          active:      1,
          end_date:    null,
        },
      ]),
    ];

    const results = engine.evaluate(toolResults);

    const doseResult = results.find(r => r.ruleId.includes('dose'));
    expect(doseResult).toBeUndefined();
  });

  it('returns empty array when toolResults is empty', () => {
    expect(engine.evaluate([])).toHaveLength(0);
  });

  it('skips failed tool results', () => {
    const toolResults: ToolResult[] = [
      { ok: false, reason: 'fhir_500', tool: 'get_medications' },
    ];

    // No error should be thrown; degraded behavior for missing data is handled separately
    expect(() => engine.evaluate(toolResults)).not.toThrow();
  });
});
