import { describe, expect, it, vi } from 'vitest';

import { createFhirClient, FhirHttpError, isUnauthorizedError } from '../../src/fhir/client';

const BASE = 'https://localhost:9300/apis/default/fhir';

const margaretFhir = {
  resourceType: 'Patient',
  id: 'margaret-uuid',
  active: true,
  name: [{ family: 'Chen', given: ['Margaret', 'L.'] }],
  gender: 'female',
  birthDate: '1962-03-14',
  identifier: [
    {
      type: { coding: [{ code: 'PT' }] },
      value: '00012847',
    },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/fhir+json' },
  });
}

describe('createFhirClient.fetchPatient', () => {
  it('GETs Patient/<id> with Authorization + Accept headers and returns DTO', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(margaretFhir));
    const client = createFhirClient({
      baseUrl: BASE,
      getAccessToken: () => 'tok-abc',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const dto = await client.fetchPatient('margaret-uuid');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/Patient/margaret-uuid`);
    expect(init.method).toBe('GET');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok-abc');
    expect(headers.Accept).toBe('application/fhir+json');

    expect(dto.name).toBe('Margaret L. Chen');
    expect(dto.mrn).toBe('00012847');
    expect(dto.birthDate).toBe('1962-03-14');
  });

  it('omits Authorization header when no access token is available', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(margaretFhir));
    const client = createFhirClient({
      baseUrl: BASE,
      getAccessToken: () => null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await client.fetchPatient('margaret-uuid');
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it('throws FhirHttpError on 401 so callers can detect re-auth', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 401));
    const client = createFhirClient({
      baseUrl: BASE,
      getAccessToken: () => 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.fetchPatient('x')).rejects.toBeInstanceOf(FhirHttpError);
    try {
      await client.fetchPatient('x');
    } catch (err) {
      expect(isUnauthorizedError(err)).toBe(true);
      expect((err as FhirHttpError).status).toBe(401);
    }
  });

  it('throws FhirHttpError on 500', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 500));
    const client = createFhirClient({
      baseUrl: BASE,
      getAccessToken: () => 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.fetchPatient('x')).rejects.toMatchObject({
      name: 'FhirHttpError',
      status: 500,
    });
  });

  it('throws when the server returns a malformed Patient (Zod parse failure)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ resourceType: 'Patient' /* missing id */ }));
    const client = createFhirClient({
      baseUrl: BASE,
      getAccessToken: () => 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.fetchPatient('x')).rejects.toThrow();
  });

  it('strips a trailing slash from the configured baseUrl', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(margaretFhir));
    const client = createFhirClient({
      baseUrl: `${BASE}/`,
      getAccessToken: () => 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.fetchPatient('margaret-uuid');
    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/Patient/margaret-uuid`);
  });
});

describe('createFhirClient.fetchBundle', () => {
  const allergyEntry = (id: string) => ({
    resource: { resourceType: 'AllergyIntolerance', id },
  });
  const minimalParser = (raw: unknown): { id: string } => {
    if (
      typeof raw === 'object'
      && raw !== null
      && typeof (raw as { id?: unknown }).id === 'string'
    ) {
      return { id: (raw as { id: string }).id };
    }
    throw new Error('bad resource');
  };

  it('walks Bundle entries and runs each resource through the parser', async () => {
    const bundle = {
      resourceType: 'Bundle',
      entry: [allergyEntry('a1'), allergyEntry('a2')],
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(bundle));
    const client = createFhirClient({
      baseUrl: BASE,
      getAccessToken: () => 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const out = await client.fetchBundle('/AllergyIntolerance', minimalParser);
    expect(out).toEqual([{ id: 'a1' }, { id: 'a2' }]);
  });

  it('follows link[rel=next] and concatenates pages', async () => {
    const page1 = {
      resourceType: 'Bundle',
      entry: [allergyEntry('a1')],
      link: [
        {
          relation: 'next',
          url: `${BASE}/AllergyIntolerance?page=2`,
        },
      ],
    };
    const page2 = {
      resourceType: 'Bundle',
      entry: [allergyEntry('a2')],
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(page1))
      .mockResolvedValueOnce(jsonResponse(page2));
    const client = createFhirClient({
      baseUrl: BASE,
      getAccessToken: () => 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const out = await client.fetchBundle('/AllergyIntolerance', minimalParser);
    expect(out).toEqual([{ id: 'a1' }, { id: 'a2' }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('throws when the response is not a Bundle', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ resourceType: 'OperationOutcome' }));
    const client = createFhirClient({
      baseUrl: BASE,
      getAccessToken: () => 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      client.fetchBundle('/AllergyIntolerance', minimalParser),
    ).rejects.toThrow(/Bundle/);
  });
});
