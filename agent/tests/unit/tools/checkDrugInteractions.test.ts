/**
 * checkDrugInteractions tool unit tests
 *
 * Tests the deterministic local DDI lookup. The tool checks rxnorm_codes from
 * this turn's get_medications result against the local ddi-table.json.
 *
 * Key invariants:
 *   - Known DDI pair (warfarin 11289 + ibuprofen 5640) → found
 *   - Empty rxnorm_codes → degraded result (ok:true, rows:[], degraded:true)
 *   - Unknown drug pair → empty rows
 *   - Row IDs: tool:check_drug_interactions:row-<n>
 *
 * Plan reference: §5.3 checkDrugInteractions.test.ts, M3/M4, §3.3 special contract
 */

import { describe, it, expect } from 'vitest';
import { checkDrugInteractions } from '../../../src/tools/checkDrugInteractions.js';
import type { ToolContext } from '../../../src/tools/types.js';

function makeContext(): ToolContext {
  return {
    patientUuid: 'jwt-patient-uuid',
    pid: 42,
    jwt: 'test-jwt',
    fhirClient: {} as ToolContext['fhirClient'],
  };
}

describe('checkDrugInteractions tool', () => {
  // §3.3: warfarin (11289) + ibuprofen (5640) — the canonical DDI pair from the DDI table
  it('detects warfarin + ibuprofen as a known interaction', async () => {
    const result = await checkDrugInteractions(
      { rxnorm_codes: ['11289', '5640'] },
      makeContext(),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rows.length).toBeGreaterThan(0);
      const interaction = result.rows[0];
      expect(interaction!.id).toMatch(/^tool:check_drug_interactions:row-\d+$/);
      // The interaction description should mention both drugs
      const desc = JSON.stringify(interaction).toLowerCase();
      expect(desc).toMatch(/warfarin|ibuprofen/i);
    }
  });

  // §3.3 special contract: empty rxnorm_codes → degraded result
  it('returns degraded result for empty rxnorm_codes array', async () => {
    const result = await checkDrugInteractions({ rxnorm_codes: [] }, makeContext());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rows).toHaveLength(0);
      // ASSUMPTION: The tool adds a degraded: true flag and degradation_reason
      expect((result as Record<string, unknown>)['degraded']).toBe(true);
      expect((result as Record<string, unknown>)['degradation_reason']).toMatch(/rxnorm|incomplete/i);
    }
  });

  it('returns no interactions for drugs without a known DDI', async () => {
    // Lisinopril (29046) + Metformin (6809) — no major DDI
    const result = await checkDrugInteractions(
      { rxnorm_codes: ['29046', '6809'] },
      makeContext(),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Should return empty rows (no interaction) or only a coverage note
      const interactionRows = result.rows.filter(r =>
        !String(r.id).includes('coverage-note')
      );
      expect(interactionRows).toHaveLength(0);
    }
  });

  // Null RxNorm codes (AUDIT.md §4: data quality cliff)
  it('returns degraded result when all rxnorm_codes are null', async () => {
    const result = await checkDrugInteractions(
      { rxnorm_codes: [null as unknown as string, null as unknown as string] },
      makeContext(),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result as Record<string, unknown>)['degraded']).toBe(true);
    }
  });

  it('assigns sequential row IDs starting at row-0', async () => {
    const result = await checkDrugInteractions(
      { rxnorm_codes: ['11289', '5640'] },
      makeContext(),
    );

    expect(result.ok).toBe(true);
    if (result.ok && result.rows.length > 0) {
      expect(result.rows[0]!.id).toBe('tool:check_drug_interactions:row-0');
    }
  });

  it('carries tool name in the result', async () => {
    const result = await checkDrugInteractions({ rxnorm_codes: [] }, makeContext());
    expect(result.tool).toBe('check_drug_interactions');
  });

  // D5 check: rxnorm_codes come from tool context (prior get_medications call),
  // not from arbitrary model arguments
  it('uses only the provided rxnorm_codes parameter — does not fetch patient data', async () => {
    // The context has a patient UUID but the tool must NOT make FHIR calls
    const spiedContext = {
      ...makeContext(),
      fhirClient: {
        getPatient: () => { throw new Error('checkDrugInteractions must not call getPatient'); },
        searchBundle: () => { throw new Error('checkDrugInteractions must not call searchBundle'); },
      } as unknown as ToolContext['fhirClient'],
    };

    await expect(
      checkDrugInteractions({ rxnorm_codes: ['11289', '5640'] }, spiedContext),
    ).resolves.toBeDefined();
  });
});
