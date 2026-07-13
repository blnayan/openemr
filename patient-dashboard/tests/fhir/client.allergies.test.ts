import { describe, expect, it, vi } from 'vitest';

import { createFhirClient, FhirHttpError } from '../../src/fhir/client';

const BASE = 'https://localhost:9300/apis/default/fhir';

const allergyEntry = (overrides: Record<string, unknown> = {}) => ({
  resource: {
    resourceType: 'AllergyIntolerance',
    id: 'a1',
    criticality: 'high',
    clinicalStatus: { coding: [{ code: 'active' }] },
    code: { coding: [{ display: 'Penicillin' }] },
    reaction: [{ severity: 'severe' }],
    ...overrides,
  },
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/fhir+json' },
  });
}

describe('createFhirClient.fetchAllergies', () => {
  it('GETs /AllergyIntolerance?patient=<id> and parses each entry', async () => {
    const bundle = {
      resourceType: 'Bundle',
      entry: [
        allergyEntry({ id: 'a1', code: { coding: [{ display: 'Penicillin' }] } }),
        allergyEntry({
          id: 'a2',
          criticality: 'low',
          code: { text: 'Sulfa drugs' },
          reaction: [{ severity: 'mild' }],
        }),
        // Issue #38: real OpenEMR shape — data-absent-reason coding placeholder
        // with the actual allergen name parked in `text.div`. The DTO must
        // resolve the name from the narrative wrapper, not the placeholder.
        allergyEntry({
          id: 'a3',
          criticality: 'low',
          clinicalStatus: { coding: [{ code: 'active' }] },
          code: {
            coding: [
              {
                system: 'http://terminology.hl7.org/CodeSystem/data-absent-reason',
                code: 'unknown',
                display: 'Unknown',
              },
            ],
          },
          text: {
            status: 'additional',
            div: "<div xmlns='http://www.w3.org/1999/xhtml'>shellfish?? maybe iodine</div>",
          },
          reaction: undefined,
        }),
      ],
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(bundle));
    const client = createFhirClient({
      baseUrl: BASE,
      getAccessToken: () => 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const allergies = await client.fetchAllergies('margaret-uuid');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/AllergyIntolerance?patient=margaret-uuid`);

    expect(allergies).toEqual([
      {
        id: 'a1',
        name: 'Penicillin',
        criticality: 'high',
        reactionSeverity: 'severe',
        clinicalStatus: 'active',
      },
      {
        id: 'a2',
        name: 'Sulfa drugs',
        criticality: 'low',
        reactionSeverity: 'mild',
        clinicalStatus: 'active',
      },
      {
        id: 'a3',
        name: 'shellfish?? maybe iodine',
        criticality: 'low',
        reactionSeverity: null,
        clinicalStatus: 'active',
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
    await client.fetchAllergies('weird id with spaces/&?');
    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `${BASE}/AllergyIntolerance?patient=weird%20id%20with%20spaces%2F%26%3F`,
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
    const out = await client.fetchAllergies('margaret-uuid');
    expect(out).toEqual([]);
  });

  it('propagates 401 as FhirHttpError', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 401));
    const client = createFhirClient({
      baseUrl: BASE,
      getAccessToken: () => 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.fetchAllergies('x')).rejects.toBeInstanceOf(FhirHttpError);
  });
});
