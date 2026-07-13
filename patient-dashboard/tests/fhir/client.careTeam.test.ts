import { describe, expect, it, vi } from 'vitest';

import { createFhirClient, FhirHttpError } from '../../src/fhir/client';
import { isActiveCareTeamParticipant } from '../../src/fhir/hooks/useCareTeam';

const BASE = 'https://localhost:9300/apis/default/fhir';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/fhir+json' },
  });
}

function careTeamEntry(overrides: Record<string, unknown> = {}) {
  return {
    resource: {
      resourceType: 'CareTeam',
      id: 'ct1',
      status: 'active',
      participant: [
        {
          id: 'p1',
          role: [{ coding: [{ display: 'Primary Care Provider' }] }],
          member: { display: 'Dr Anita Smith' },
        },
        {
          id: 'p2',
          role: [{ text: 'Cardiologist' }],
          member: { display: 'Dr Marcus Jones' },
        },
      ],
      ...overrides,
    },
  };
}

describe('createFhirClient.fetchCareTeam', () => {
  it('GETs /CareTeam?patient=<id> and flattens participants across resources', async () => {
    const bundle = {
      resourceType: 'Bundle',
      entry: [
        careTeamEntry({ id: 'ct1' }),
        careTeamEntry({
          id: 'ct2',
          status: 'active',
          participant: [
            {
              id: 'p1',
              role: [{ text: 'Nurse' }],
              member: { display: 'Nurse Reyes' },
            },
          ],
        }),
      ],
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(bundle));
    const client = createFhirClient({
      baseUrl: BASE,
      getAccessToken: () => 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const participants = await client.fetchCareTeam('margaret-uuid');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/CareTeam?patient=margaret-uuid`);

    expect(participants).toEqual([
      {
        careTeamId: 'ct1',
        participantId: 'ct1:p1',
        status: 'active',
        name: 'Dr Anita Smith',
        role: 'Primary Care Provider',
      },
      {
        careTeamId: 'ct1',
        participantId: 'ct1:p2',
        status: 'active',
        name: 'Dr Marcus Jones',
        role: 'Cardiologist',
      },
      {
        careTeamId: 'ct2',
        participantId: 'ct2:p1',
        status: 'active',
        name: 'Nurse Reyes',
        role: 'Nurse',
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
    await client.fetchCareTeam('weird id with spaces/&?');
    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `${BASE}/CareTeam?patient=weird%20id%20with%20spaces%2F%26%3F`,
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
    const out = await client.fetchCareTeam('margaret-uuid');
    expect(out).toEqual([]);
  });

  it('returns an empty array for a CareTeam with no participants', async () => {
    const bundle = {
      resourceType: 'Bundle',
      entry: [
        {
          resource: {
            resourceType: 'CareTeam',
            id: 'ct1',
            status: 'active',
            participant: [],
          },
        },
      ],
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(bundle));
    const client = createFhirClient({
      baseUrl: BASE,
      getAccessToken: () => 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const out = await client.fetchCareTeam('p');
    expect(out).toEqual([]);
  });

  it('propagates 401 as FhirHttpError', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 401));
    const client = createFhirClient({
      baseUrl: BASE,
      getAccessToken: () => 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.fetchCareTeam('x')).rejects.toBeInstanceOf(
      FhirHttpError,
    );
  });

  it('returns parsed DTOs without filtering — including inactive entries', async () => {
    // Filter policy lives in the hook, not the client. The client must
    // faithfully return every entry it pulled out of the Bundle.
    const bundle = {
      resourceType: 'Bundle',
      entry: [
        careTeamEntry({ id: 'active-team', status: 'active' }),
        careTeamEntry({ id: 'inactive-team', status: 'inactive' }),
        careTeamEntry({ id: 'erred-team', status: 'entered-in-error' }),
      ],
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(bundle));
    const client = createFhirClient({
      baseUrl: BASE,
      getAccessToken: () => 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const participants = await client.fetchCareTeam('p');
    expect(participants.map((p) => p.careTeamId)).toEqual([
      'active-team',
      'active-team',
      'inactive-team',
      'inactive-team',
      'erred-team',
      'erred-team',
    ]);
  });
});

describe('isActiveCareTeamParticipant (hook-layer filter)', () => {
  const base = {
    careTeamId: 'ct1',
    participantId: 'ct1:p1',
    name: 'Dr X',
    role: 'PCP',
  };

  it('keeps status=active', () => {
    expect(isActiveCareTeamParticipant({ ...base, status: 'active' })).toBe(
      true,
    );
  });

  it('keeps null status (legacy rows)', () => {
    expect(isActiveCareTeamParticipant({ ...base, status: null })).toBe(true);
  });

  it('drops status=inactive / entered-in-error / suspended', () => {
    for (const s of ['inactive', 'entered-in-error', 'suspended']) {
      expect(isActiveCareTeamParticipant({ ...base, status: s })).toBe(false);
    }
  });
});
