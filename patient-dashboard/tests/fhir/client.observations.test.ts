import { describe, expect, it, vi } from 'vitest';

import { createFhirClient, FhirHttpError } from '../../src/fhir/client';
import {
  isReleasedLabResult,
  compareByEffectiveDateDesc,
} from '../../src/fhir/hooks/useLabResults';
import type { LabObservationDTO } from '../../src/fhir/schemas/observation';

const BASE = 'https://localhost:9300/apis/default/fhir';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/fhir+json' },
  });
}

function obsEntry(overrides: Record<string, unknown> = {}) {
  return {
    resource: {
      resourceType: 'Observation',
      id: 'o1',
      status: 'final',
      code: { coding: [{ display: 'Hemoglobin A1c' }] },
      valueQuantity: { value: 7.4, unit: '%' },
      interpretation: [{ coding: [{ code: 'H' }] }],
      effectiveDateTime: '2024-03-12',
      ...overrides,
    },
  };
}

describe('createFhirClient.fetchObservations', () => {
  it('GETs /Observation?patient=<id>&category=<cat> with the laboratory category', async () => {
    const bundle = {
      resourceType: 'Bundle',
      entry: [obsEntry({ id: 'o1' }), obsEntry({ id: 'o2' })],
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(bundle));
    const client = createFhirClient({
      baseUrl: BASE,
      getAccessToken: () => 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const observations = await client.fetchObservations(
      'margaret-uuid',
      'laboratory',
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `${BASE}/Observation?patient=margaret-uuid&category=laboratory`,
    );
    expect(observations).toHaveLength(2);
    expect(observations[0]).toMatchObject({
      id: 'o1',
      name: 'Hemoglobin A1c',
      valueDisplay: '7.4 %',
      flag: 'high',
      status: 'final',
    });
  });

  it('URL-encodes both the patient id and the category', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ resourceType: 'Bundle', entry: [] }));
    const client = createFhirClient({
      baseUrl: BASE,
      getAccessToken: () => 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.fetchObservations('weird id/&?', 'lab category/&?');
    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `${BASE}/Observation?patient=weird%20id%2F%26%3F&category=lab%20category%2F%26%3F`,
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
    const out = await client.fetchObservations('p', 'laboratory');
    expect(out).toEqual([]);
  });

  it('propagates 401 as FhirHttpError', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 401));
    const client = createFhirClient({
      baseUrl: BASE,
      getAccessToken: () => 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      client.fetchObservations('x', 'laboratory'),
    ).rejects.toBeInstanceOf(FhirHttpError);
  });

  it('returns parsed DTOs without filtering — including non-final statuses', async () => {
    // Filter policy lives in the hook, not the client. The client must
    // faithfully return every entry it pulled out of the Bundle.
    const bundle = {
      resourceType: 'Bundle',
      entry: [
        obsEntry({ id: 'final', status: 'final' }),
        obsEntry({ id: 'prelim', status: 'preliminary' }),
        obsEntry({ id: 'erred', status: 'entered-in-error' }),
      ],
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(bundle));
    const client = createFhirClient({
      baseUrl: BASE,
      getAccessToken: () => 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const out = await client.fetchObservations('p', 'laboratory');
    expect(out.map((o) => o.status)).toEqual([
      'final',
      'preliminary',
      'entered-in-error',
    ]);
  });
});

describe('isReleasedLabResult (hook-layer filter)', () => {
  const base: LabObservationDTO = {
    id: 'o1',
    name: 'A1c',
    valueDisplay: '7.4 %',
    flag: 'high',
    referenceRange: null,
    effectiveDateTime: '2024-03-12',
    status: 'final',
  };

  it('keeps status=final', () => {
    expect(isReleasedLabResult({ ...base, status: 'final' })).toBe(true);
  });

  it('keeps status=amended and status=corrected', () => {
    expect(isReleasedLabResult({ ...base, status: 'amended' })).toBe(true);
    expect(isReleasedLabResult({ ...base, status: 'corrected' })).toBe(true);
  });

  it('keeps null status (legacy parity with other cards)', () => {
    expect(isReleasedLabResult({ ...base, status: null })).toBe(true);
  });

  it('drops preliminary / cancelled / entered-in-error / registered', () => {
    for (const s of ['preliminary', 'cancelled', 'entered-in-error', 'registered']) {
      expect(isReleasedLabResult({ ...base, status: s })).toBe(false);
    }
  });
});

describe('compareByEffectiveDateDesc (hook-layer sort)', () => {
  const dto = (
    id: string,
    effectiveDateTime: string | null,
  ): LabObservationDTO => ({
    id,
    name: 'X',
    valueDisplay: 'v',
    flag: 'normal',
    referenceRange: null,
    effectiveDateTime,
    status: 'final',
  });

  it('sorts newest first by ISO date', () => {
    const sorted = [
      dto('a', '2024-01-01'),
      dto('b', '2024-03-15'),
      dto('c', '2024-02-10'),
    ].sort(compareByEffectiveDateDesc);
    expect(sorted.map((o) => o.id)).toEqual(['b', 'c', 'a']);
  });

  it('sinks rows missing effectiveDateTime to the end', () => {
    const sorted = [
      dto('a', null),
      dto('b', '2024-03-15'),
      dto('c', null),
    ].sort(compareByEffectiveDateDesc);
    expect(sorted.map((o) => o.id)).toEqual(['b', 'a', 'c']);
  });
});
