import { describe, expect, it, vi } from 'vitest';

import { createFhirClient, FhirHttpError } from '../../src/fhir/client';
import { isActiveProblem } from '../../src/fhir/hooks/useConditions';

const BASE = 'https://localhost:9300/apis/default/fhir';

const conditionEntry = (overrides: Record<string, unknown> = {}) => ({
  resource: {
    resourceType: 'Condition',
    id: 'c1',
    clinicalStatus: { coding: [{ code: 'active' }] },
    verificationStatus: { coding: [{ code: 'confirmed' }] },
    code: { coding: [{ display: 'Hypertension' }] },
    recordedDate: '2024-01-15',
    ...overrides,
  },
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/fhir+json' },
  });
}

describe('createFhirClient.fetchConditions', () => {
  it('GETs /Condition?patient=<id> and parses each entry', async () => {
    const bundle = {
      resourceType: 'Bundle',
      entry: [
        conditionEntry({ id: 'c1', code: { coding: [{ display: 'Hypertension' }] } }),
        conditionEntry({
          id: 'c2',
          code: { text: 'Type 2 diabetes' },
          recordedDate: '2023-05-02',
        }),
      ],
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(bundle));
    const client = createFhirClient({
      baseUrl: BASE,
      getAccessToken: () => 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const conditions = await client.fetchConditions('margaret-uuid');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/Condition?patient=margaret-uuid`);

    expect(conditions).toEqual([
      {
        id: 'c1',
        name: 'Hypertension',
        clinicalStatus: 'active',
        verificationStatus: 'confirmed',
        recordedDate: '2024-01-15',
      },
      {
        id: 'c2',
        name: 'Type 2 diabetes',
        clinicalStatus: 'active',
        verificationStatus: 'confirmed',
        recordedDate: '2023-05-02',
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
    await client.fetchConditions('weird id with spaces/&?');
    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `${BASE}/Condition?patient=weird%20id%20with%20spaces%2F%26%3F`,
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
    const out = await client.fetchConditions('margaret-uuid');
    expect(out).toEqual([]);
  });

  it('propagates 401 as FhirHttpError', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 401));
    const client = createFhirClient({
      baseUrl: BASE,
      getAccessToken: () => 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.fetchConditions('x')).rejects.toBeInstanceOf(FhirHttpError);
  });

  it('returns parsed DTOs without filtering — including resolved entries', async () => {
    // Filter policy lives in the hook, not the client. The client must
    // faithfully return every entry it pulled out of the Bundle.
    const bundle = {
      resourceType: 'Bundle',
      entry: [
        conditionEntry({ id: 'active', clinicalStatus: { coding: [{ code: 'active' }] } }),
        conditionEntry({
          id: 'resolved',
          clinicalStatus: { coding: [{ code: 'resolved' }] },
        }),
        conditionEntry({
          id: 'refuted',
          verificationStatus: { coding: [{ code: 'refuted' }] },
        }),
      ],
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(bundle));
    const client = createFhirClient({
      baseUrl: BASE,
      getAccessToken: () => 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const conditions = await client.fetchConditions('p');
    expect(conditions.map((c) => c.id)).toEqual(['active', 'resolved', 'refuted']);
  });
});

describe('isActiveProblem (hook-layer filter)', () => {
  it('keeps clinicalStatus=active', () => {
    expect(
      isActiveProblem({
        id: 'a',
        name: 'X',
        clinicalStatus: 'active',
        verificationStatus: 'confirmed',
        recordedDate: null,
      }),
    ).toBe(true);
  });

  it('keeps clinicalStatus=recurrence and clinicalStatus=relapse', () => {
    expect(
      isActiveProblem({
        id: 'a',
        name: 'X',
        clinicalStatus: 'recurrence',
        verificationStatus: null,
        recordedDate: null,
      }),
    ).toBe(true);
    expect(
      isActiveProblem({
        id: 'a',
        name: 'X',
        clinicalStatus: 'relapse',
        verificationStatus: null,
        recordedDate: null,
      }),
    ).toBe(true);
  });

  it('keeps null clinicalStatus (legacy rows)', () => {
    expect(
      isActiveProblem({
        id: 'a',
        name: 'X',
        clinicalStatus: null,
        verificationStatus: null,
        recordedDate: null,
      }),
    ).toBe(true);
  });

  it('drops clinicalStatus=resolved / inactive / remission', () => {
    for (const status of ['resolved', 'inactive', 'remission']) {
      expect(
        isActiveProblem({
          id: 'a',
          name: 'X',
          clinicalStatus: status,
          verificationStatus: 'confirmed',
          recordedDate: null,
        }),
      ).toBe(false);
    }
  });

  it('drops verificationStatus=refuted even if clinicalStatus is active', () => {
    expect(
      isActiveProblem({
        id: 'a',
        name: 'X',
        clinicalStatus: 'active',
        verificationStatus: 'refuted',
        recordedDate: null,
      }),
    ).toBe(false);
  });

  it('drops verificationStatus=entered-in-error even if clinicalStatus is active', () => {
    expect(
      isActiveProblem({
        id: 'a',
        name: 'X',
        clinicalStatus: 'active',
        verificationStatus: 'entered-in-error',
        recordedDate: null,
      }),
    ).toBe(false);
  });

  it('keeps unconfirmed / provisional / differential verification', () => {
    for (const status of ['unconfirmed', 'provisional', 'differential']) {
      expect(
        isActiveProblem({
          id: 'a',
          name: 'X',
          clinicalStatus: 'active',
          verificationStatus: status,
          recordedDate: null,
        }),
      ).toBe(true);
    }
  });
});
