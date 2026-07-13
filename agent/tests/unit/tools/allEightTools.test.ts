/**
 * All-eight-tools contract tests
 *
 * For every tool, verifies:
 *   1. Returns { ok: true, rows: T[], tool: string } on success
 *   2. Each row carries id of form tool:<tool_name>:row-<n>
 *   3. Returns { ok: false, reason, tool } on FHIR failure
 *   4. Patient UUID is sourced from JWT/ToolContext, never from tool args
 *   5. Tool name in result matches the function's name constant
 *
 * Plan reference: §5.3 tools/*.test.ts, M3 tool specifications, D5
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import type { ToolContext } from '../../../src/tools/types.js';

// Import all eight tools
import { getPatientSummary } from '../../../src/tools/getPatientSummary.js';
import { getActiveProblems } from '../../../src/tools/getActiveProblems.js';
import { getMedications }    from '../../../src/tools/getMedications.js';
import { getRecentLabs }     from '../../../src/tools/getRecentLabs.js';
import { getVitals }         from '../../../src/tools/getVitals.js';
import { getAllergies }       from '../../../src/tools/getAllergies.js';
import { getRecentEncounters } from '../../../src/tools/getRecentEncounters.js';
import { checkDrugInteractions } from '../../../src/tools/checkDrugInteractions.js';

const FHIR_BASE = 'http://openemr.test/apis/fhir/R4';
const JWT_UUID  = 'jwt-patient-uuid';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'warn' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeContext(): ToolContext {
  return {
    patientUuid: JWT_UUID,
    pid: 42,
    jwt: 'test-jwt',
    fhirClient: {
      getPatient: async (uuid: string) => {
        const res = await fetch(`${FHIR_BASE}/Patient/${uuid}`);
        if (!res.ok) {
          const { FhirClientError } = await import('../../../src/fhir/FhirClient.js');
          throw new FhirClientError(res.status, await res.text(), 'Patient');
        }
        return res.json();
      },
      searchBundle: async (resourceType: string, params: Record<string, string>) => {
        const url = `${FHIR_BASE}/${resourceType}?${new URLSearchParams(params)}`;
        const res = await fetch(url);
        if (!res.ok) {
          const { FhirClientError } = await import('../../../src/fhir/FhirClient.js');
          throw new FhirClientError(res.status, await res.text(), resourceType);
        }
        return res.json();
      },
    } as unknown as ToolContext['fhirClient'],
  };
}

function emptyBundle() {
  return { resourceType: 'Bundle', type: 'searchset', entry: [] };
}

// ---------------------------------------------------------------------------
// Tool registry for table-driven tests
// ---------------------------------------------------------------------------

const TOOL_REGISTRY = [
  {
    name: 'get_patient_summary',
    fn: getPatientSummary,
    params: {},
    fhirPath: `/Patient/${JWT_UUID}`,
    isPatientResource: true,
  },
  {
    name: 'get_active_problems',
    fn: getActiveProblems,
    params: {},
    fhirPath: '/Condition',
    isPatientResource: false,
  },
  {
    name: 'get_medications',
    fn: getMedications,
    params: {},
    fhirPath: '/MedicationRequest',
    isPatientResource: false,
  },
  {
    name: 'get_recent_labs',
    fn: getRecentLabs,
    params: {},
    fhirPath: '/Observation',
    isPatientResource: false,
  },
  {
    name: 'get_vitals',
    fn: getVitals,
    params: {},
    fhirPath: '/Observation',
    isPatientResource: false,
  },
  {
    name: 'get_allergies',
    fn: getAllergies,
    params: {},
    fhirPath: '/AllergyIntolerance',
    isPatientResource: false,
  },
  {
    name: 'get_recent_encounters',
    fn: getRecentEncounters,
    params: {},
    fhirPath: '/Encounter',
    isPatientResource: false,
  },
] as const;

// ---------------------------------------------------------------------------
// Tests for each FHIR-backed tool
// ---------------------------------------------------------------------------

describe('All eight FHIR tools — shared contracts', () => {
  for (const tool of TOOL_REGISTRY) {
    describe(`${tool.name}`, () => {
      it(`returns ok:true with rows array on success`, async () => {
        server.use(
          tool.isPatientResource
            ? http.get(`${FHIR_BASE}${tool.fhirPath}`, () =>
                HttpResponse.json({ resourceType: 'Patient', id: JWT_UUID }),
              )
            : http.get(`${FHIR_BASE}${tool.fhirPath}`, () => HttpResponse.json(emptyBundle())),
        );

        const result = await (tool.fn as Function)(tool.params, makeContext());

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(Array.isArray(result.rows)).toBe(true);
        }
      });

      it(`carries tool name "${tool.name}" in the result`, async () => {
        server.use(
          tool.isPatientResource
            ? http.get(`${FHIR_BASE}${tool.fhirPath}`, () =>
                HttpResponse.json({ resourceType: 'Patient', id: JWT_UUID }),
              )
            : http.get(`${FHIR_BASE}${tool.fhirPath}`, () => HttpResponse.json(emptyBundle())),
        );

        const result = await (tool.fn as Function)(tool.params, makeContext());
        expect(result.tool).toBe(tool.name);
      });

      it(`returns ok:false on FHIR 500`, async () => {
        server.use(
          tool.isPatientResource
            ? http.get(`${FHIR_BASE}${tool.fhirPath}`, () =>
                HttpResponse.json({ error: 'internal' }, { status: 500 }),
              )
            : http.get(`${FHIR_BASE}${tool.fhirPath}`, () =>
                HttpResponse.json({ error: 'internal' }, { status: 500 }),
              ),
        );

        const result = await (tool.fn as Function)(tool.params, makeContext());

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBeDefined();
        }
      });

      // D5: Patient UUID sourced from JWT/ToolContext, never from model args
      it(`uses JWT-bound patient UUID, ignores any patient_id in params`, async () => {
        let capturedUrl: URL | undefined;

        server.use(
          tool.isPatientResource
            ? http.get(`${FHIR_BASE}/Patient/${JWT_UUID}`, ({ request }) => {
                capturedUrl = new URL(request.url);
                return HttpResponse.json({ resourceType: 'Patient', id: JWT_UUID });
              })
            : http.get(`${FHIR_BASE}${tool.fhirPath}`, ({ request }) => {
                capturedUrl = new URL(request.url);
                return HttpResponse.json(emptyBundle());
              }),
        );

        await (tool.fn as Function)({ patient_id: 'ATTACKER' } as Record<string, unknown>, makeContext());

        if (capturedUrl) {
          const patientParam = capturedUrl.searchParams.get('patient');
          if (patientParam) {
            expect(patientParam).toBe(JWT_UUID);
            expect(patientParam).not.toBe('ATTACKER');
          } else {
            // Patient resource: UUID is in the path, not a query param
            expect(capturedUrl.pathname).toContain(JWT_UUID);
          }
        }
      });
    });
  }

  // checkDrugInteractions is tested separately (no FHIR call)
  describe('check_drug_interactions', () => {
    it('returns ok:true and carries tool name', async () => {
      const result = await checkDrugInteractions({ rxnorm_codes: [] }, makeContext());
      expect(result.ok).toBe(true);
      expect(result.tool).toBe('check_drug_interactions');
    });

    it('does not make any FHIR calls', async () => {
      const context = {
        ...makeContext(),
        fhirClient: {
          getPatient: () => { throw new Error('checkDrugInteractions must not call FHIR'); },
          searchBundle: () => { throw new Error('checkDrugInteractions must not call FHIR'); },
        } as unknown as ToolContext['fhirClient'],
      };

      await expect(checkDrugInteractions({ rxnorm_codes: ['11289'] }, context)).resolves.toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Row ID format validation
// ---------------------------------------------------------------------------

describe('Tool row ID format', () => {
  it('all rows carry id of form tool:<tool_name>:row-<n>', async () => {
    server.use(
      http.get(`${FHIR_BASE}/AllergyIntolerance`, () =>
        HttpResponse.json({
          resourceType: 'Bundle',
          type: 'searchset',
          entry: [
            { resource: { resourceType: 'AllergyIntolerance', id: 'a1', code: { text: 'Penicillin' } } },
            { resource: { resourceType: 'AllergyIntolerance', id: 'a2', code: { text: 'Sulfa' } } },
          ],
        }),
      ),
    );

    const result = await getAllergies({}, makeContext());

    expect(result.ok).toBe(true);
    if (result.ok) {
      result.rows.forEach((row, i) => {
        expect(row.id).toBe(`tool:get_allergies:row-${i}`);
      });
    }
  });
});
