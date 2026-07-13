import { describe, expect, it, vi } from 'vitest';

import { createFhirClient, FhirHttpError } from '../../src/fhir/client';
import { isActiveMedication } from '../../src/fhir/hooks/useMedications';

const BASE = 'https://localhost:9300/apis/default/fhir';

const medEntry = (overrides: Record<string, unknown> = {}) => ({
  resource: {
    resourceType: 'MedicationRequest',
    id: 'm1',
    status: 'active',
    intent: 'order',
    medicationCodeableConcept: {
      coding: [{ display: 'Lisinopril 10 MG Oral Tablet' }],
    },
    dosageInstruction: [{ text: 'Take 1 tablet by mouth daily' }],
    authoredOn: '2024-02-10',
    ...overrides,
  },
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/fhir+json' },
  });
}

describe('createFhirClient.fetchMedicationRequests', () => {
  it('GETs /MedicationRequest?patient=<id> and parses each entry', async () => {
    const bundle = {
      resourceType: 'Bundle',
      entry: [
        medEntry({
          id: 'm1',
          medicationCodeableConcept: { coding: [{ display: 'Lisinopril 10 MG' }] },
        }),
        medEntry({
          id: 'm2',
          medicationCodeableConcept: { text: 'Atorvastatin 20 MG' },
          dosageInstruction: [{ text: 'Take 1 tablet at bedtime' }],
          authoredOn: '2023-11-04',
        }),
      ],
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(bundle));
    const client = createFhirClient({
      baseUrl: BASE,
      getAccessToken: () => 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const meds = await client.fetchMedicationRequests('margaret-uuid');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/MedicationRequest?patient=margaret-uuid`);

    expect(meds).toEqual([
      {
        id: 'm1',
        name: 'Lisinopril 10 MG',
        dosingText: 'Take 1 tablet by mouth daily',
        status: 'active',
        intent: 'order',
        authoredOn: '2024-02-10',
      },
      {
        id: 'm2',
        name: 'Atorvastatin 20 MG',
        dosingText: 'Take 1 tablet at bedtime',
        status: 'active',
        intent: 'order',
        authoredOn: '2023-11-04',
      },
    ]);
  });

  it('URL-encodes the patient id', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ resourceType: 'Bundle', entry: [] }));
    const client = createFhirClient({
      baseUrl: BASE,
      getAccessToken: () => 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.fetchMedicationRequests('weird id with spaces/&?');
    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `${BASE}/MedicationRequest?patient=weird%20id%20with%20spaces%2F%26%3F`,
    );
  });

  it('returns an empty array for an empty Bundle', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ resourceType: 'Bundle', entry: [] }));
    const client = createFhirClient({
      baseUrl: BASE,
      getAccessToken: () => 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const out = await client.fetchMedicationRequests('margaret-uuid');
    expect(out).toEqual([]);
  });

  it('propagates 401 as FhirHttpError', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 401));
    const client = createFhirClient({
      baseUrl: BASE,
      getAccessToken: () => 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.fetchMedicationRequests('x')).rejects.toBeInstanceOf(
      FhirHttpError,
    );
  });

  it('returns parsed DTOs without filtering — including completed entries', async () => {
    // Filter policy lives in the hook, not the client. The client must
    // faithfully return every entry it pulled out of the Bundle.
    const bundle = {
      resourceType: 'Bundle',
      entry: [
        medEntry({ id: 'active', status: 'active' }),
        medEntry({ id: 'completed', status: 'completed' }),
        medEntry({ id: 'stopped', status: 'stopped' }),
      ],
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(bundle));
    const client = createFhirClient({
      baseUrl: BASE,
      getAccessToken: () => 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const meds = await client.fetchMedicationRequests('p');
    expect(meds.map((m) => m.id)).toEqual(['active', 'completed', 'stopped']);
  });
});

describe('isActiveMedication (hook-layer filter)', () => {
  function dto(status: string | null): {
    id: string;
    name: string;
    dosingText: string | null;
    status: string | null;
    intent: string | null;
    authoredOn: string | null;
  } {
    return {
      id: 'a',
      name: 'X',
      dosingText: null,
      status,
      intent: null,
      authoredOn: null,
    };
  }

  it('keeps status=active', () => {
    expect(isActiveMedication(dto('active'))).toBe(true);
  });

  it('drops every non-active status', () => {
    for (const status of [
      'on-hold',
      'cancelled',
      'completed',
      'entered-in-error',
      'stopped',
      'draft',
      'unknown',
    ]) {
      expect(isActiveMedication(dto(status))).toBe(false);
    }
  });

  it('drops null status (FHIR R4 requires status; missing is a data-quality issue)', () => {
    expect(isActiveMedication(dto(null))).toBe(false);
  });
});
