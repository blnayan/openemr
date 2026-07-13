/**
 * getMedications tool unit tests
 *
 * Critical invariants from AUDIT.md §4 (data quality):
 *   - Excludes medications where end_date is in the past (even if active=1)
 *   - Includes medications where active=1 AND end_date IS NULL
 *   - Patient UUID comes from JWT/ToolContext, never from model args
 *   - Returns { ok: false, reason } on FHIR error
 *
 * Every returned row must have id of form tool:get_medications:row-<n>
 *
 * Plan reference: §5.3 getMedications.test.ts, M3 tool specs, AUDIT.md §4
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { getMedications } from '../../../src/tools/getMedications.js';
import type { ToolContext } from '../../../src/tools/types.js';

const FHIR_BASE = 'http://openemr.test/apis/fhir/R4';
const JWT_UUID  = 'jwt-bound-patient-uuid';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeContext(): ToolContext {
  return {
    patientUuid: JWT_UUID,
    pid: 42,
    jwt: 'test-jwt',
    fhirClient: {
      getPatient: async () => ({ resourceType: 'Patient', id: JWT_UUID }),
      searchBundle: async (_resourceType: string, params: Record<string, string>) => {
        const url = `${FHIR_BASE}/MedicationRequest?${new URLSearchParams(params)}`;
        const res = await fetch(url, { headers: { Authorization: 'Bearer test-jwt' } });
        return res.json();
      },
    } as unknown as ToolContext['fhirClient'],
  };
}

function buildMedicationEntry(overrides: {
  id: string;
  drugName: string;
  rxnorm?: string;
  status?: string;
  endDate?: string | null;
}) {
  return {
    resource: {
      resourceType: 'MedicationRequest',
      id: overrides.id,
      status: overrides.status ?? 'active',
      medicationCodeableConcept: {
        text: overrides.drugName,
        coding: overrides.rxnorm ? [
          { system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: overrides.rxnorm, display: overrides.drugName },
        ] : [],
      },
      dispenseRequest: overrides.endDate !== undefined ? {
        validityPeriod: { end: overrides.endDate },
      } : undefined,
    },
  };
}

function bundleResponse(entries: ReturnType<typeof buildMedicationEntry>[]) {
  return { resourceType: 'Bundle', type: 'searchset', entry: entries };
}

// ---------------------------------------------------------------------------

describe('getMedications tool', () => {
  it('returns ok:true with rows for active medications', async () => {
    server.use(
      http.get(`${FHIR_BASE}/MedicationRequest`, () =>
        HttpResponse.json(bundleResponse([
          buildMedicationEntry({ id: 'med-1', drugName: 'Lisinopril', rxnorm: '29046', endDate: null }),
        ])),
      ),
    );

    const result = await getMedications({}, makeContext());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]!.id).toBe('tool:get_medications:row-0');
    }
  });

  // AUDIT.md §4: "active=1 AND end_date in past is a legal state" → exclude expired
  it('excludes medications with end_date in the past (AUDIT.md §4)', async () => {
    const pastDate = '2020-01-01';  // clearly in the past

    server.use(
      http.get(`${FHIR_BASE}/MedicationRequest`, () =>
        HttpResponse.json(bundleResponse([
          buildMedicationEntry({ id: 'med-expired', drugName: 'Old Drug', rxnorm: '999', endDate: pastDate }),
          buildMedicationEntry({ id: 'med-active', drugName: 'Current Drug', rxnorm: '111', endDate: null }),
        ])),
      ),
    );

    const result = await getMedications({}, makeContext());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]!['drug_name']).toBe('Current Drug');
    }
  });

  // D5: Patient UUID comes from context (JWT), never from model params
  it('uses patient UUID from ToolContext (JWT), not from tool params', async () => {
    let capturedParams: Record<string, string> = {};

    server.use(
      http.get(`${FHIR_BASE}/MedicationRequest`, ({ request }) => {
        capturedParams = Object.fromEntries(new URL(request.url).searchParams);
        return HttpResponse.json(bundleResponse([]));
      }),
    );

    // Even if params contains a rogue patient_id, the tool must use JWT UUID
    await getMedications({ patient_id: 'ATTACKER-UUID' } as Record<string, unknown>, makeContext());

    expect(capturedParams['patient']).toBe(JWT_UUID);
    expect(capturedParams['patient']).not.toBe('ATTACKER-UUID');
  });

  it('returns ok:false on FHIR 404', async () => {
    server.use(
      http.get(`${FHIR_BASE}/MedicationRequest`, () =>
        HttpResponse.json({ resourceType: 'OperationOutcome' }, { status: 404 }),
      ),
    );

    const result = await getMedications({}, makeContext());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/fhir_404|not_found/i);
    }
  });

  it('returns ok:false on FHIR 500', async () => {
    server.use(
      http.get(`${FHIR_BASE}/MedicationRequest`, () =>
        HttpResponse.json({ error: 'internal' }, { status: 500 }),
      ),
    );

    const result = await getMedications({}, makeContext());

    expect(result.ok).toBe(false);
  });

  it('returns ok:true with empty rows when no active medications exist', async () => {
    server.use(
      http.get(`${FHIR_BASE}/MedicationRequest`, () =>
        HttpResponse.json(bundleResponse([])),
      ),
    );

    const result = await getMedications({}, makeContext());

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rows).toHaveLength(0);
  });

  it('assigns sequential row IDs starting at row-0', async () => {
    server.use(
      http.get(`${FHIR_BASE}/MedicationRequest`, () =>
        HttpResponse.json(bundleResponse([
          buildMedicationEntry({ id: 'med-1', drugName: 'A', endDate: null }),
          buildMedicationEntry({ id: 'med-2', drugName: 'B', endDate: null }),
          buildMedicationEntry({ id: 'med-3', drugName: 'C', endDate: null }),
        ])),
      ),
    );

    const result = await getMedications({}, makeContext());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rows[0]!.id).toBe('tool:get_medications:row-0');
      expect(result.rows[1]!.id).toBe('tool:get_medications:row-1');
      expect(result.rows[2]!.id).toBe('tool:get_medications:row-2');
    }
  });

  it('carries tool name in the result', async () => {
    server.use(
      http.get(`${FHIR_BASE}/MedicationRequest`, () => HttpResponse.json(bundleResponse([]))),
    );

    const result = await getMedications({}, makeContext());
    expect(result.tool).toBe('get_medications');
  });
});
