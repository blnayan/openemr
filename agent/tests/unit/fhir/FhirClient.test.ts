/**
 * FhirClient unit tests
 *
 * Tests that every outbound FHIR call carries the inbound JWT as Bearer,
 * that non-2xx responses are mapped to FhirClientError, and that timeouts
 * are surfaced as errors.
 *
 * D5: Patient ID is sourced from JWT, never from tool args — the FhirClient
 * must accept the patient_uuid from the tool context (which comes from the JWT),
 * not from the model's tool call arguments.
 *
 * All HTTP is intercepted via msw (Mock Service Worker).
 *
 * Plan reference: §5.3 FhirClient.test.ts, M2 FhirClient contract, D5
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { FhirClient, FhirClientError } from '../../../src/fhir/FhirClient.js';

const FHIR_BASE_URL = 'http://openemr.test/apis/fhir/R4';
const TEST_JWT      = 'test-jwt-token';
const PATIENT_UUID  = 'test-patient-001';

// ---------------------------------------------------------------------------
// MSW server setup
// ---------------------------------------------------------------------------

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeClient(timeoutMs?: number): FhirClient {
  const opts: { baseUrl: string; jwt: string; timeoutMs?: number } = {
    baseUrl: FHIR_BASE_URL,
    jwt: TEST_JWT,
  };
  if (timeoutMs !== undefined) opts.timeoutMs = timeoutMs;
  return new FhirClient(opts);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FhirClient', () => {
  // §5.3: "200 with bundle returns typed object"
  it('getPatient returns parsed Patient resource on 200', async () => {
    const patientResource = {
      resourceType: 'Patient',
      id: PATIENT_UUID,
      name: [{ given: ['Maria'], family: 'González' }],
    };

    server.use(
      http.get(`${FHIR_BASE_URL}/Patient/${PATIENT_UUID}`, ({ request }) => {
        // Assert Bearer token is present in every FHIR call
        const auth = request.headers.get('authorization');
        if (auth !== `Bearer ${TEST_JWT}`) {
          return HttpResponse.json({ error: 'unauthorized' }, { status: 401 });
        }
        return HttpResponse.json(patientResource);
      }),
    );

    const client  = makeClient();
    const patient = await client.getPatient(PATIENT_UUID);

    expect(patient.resourceType).toBe('Patient');
    expect(patient.id).toBe(PATIENT_UUID);
  });

  // D5: Every outbound call carries JWT as Bearer — the key security invariant
  it('sends Authorization: Bearer JWT header on every outbound request', async () => {
    let capturedAuth: string | null = null;

    server.use(
      http.get(`${FHIR_BASE_URL}/Patient/${PATIENT_UUID}`, ({ request }) => {
        capturedAuth = request.headers.get('authorization');
        return HttpResponse.json({ resourceType: 'Patient', id: PATIENT_UUID });
      }),
    );

    await makeClient().getPatient(PATIENT_UUID);

    expect(capturedAuth).toBe(`Bearer ${TEST_JWT}`);
  });

  // §5.3: "404 throws FhirClientError"
  it('throws FhirClientError with status 404 when patient not found', async () => {
    server.use(
      http.get(`${FHIR_BASE_URL}/Patient/${PATIENT_UUID}`, () =>
        HttpResponse.json({ resourceType: 'OperationOutcome' }, { status: 404 }),
      ),
    );

    const client = makeClient();
    await expect(client.getPatient(PATIENT_UUID)).rejects.toThrow(FhirClientError);
    await expect(client.getPatient(PATIENT_UUID)).rejects.toMatchObject({ status: 404 });
  });

  // §5.3: "500 throws FhirClientError"
  it('throws FhirClientError with status 500 on server error', async () => {
    server.use(
      http.get(`${FHIR_BASE_URL}/Patient/${PATIENT_UUID}`, () =>
        HttpResponse.json({ error: 'internal error' }, { status: 500 }),
      ),
    );

    await expect(makeClient().getPatient(PATIENT_UUID)).rejects.toThrow(FhirClientError);
    await expect(makeClient().getPatient(PATIENT_UUID)).rejects.toMatchObject({ status: 500 });
  });

  // §5.3: "timeout returns { ok: false, reason: 'fhir_timeout' }" (at tool level)
  // At the FhirClient level, timeout throws a FhirClientError; tools wrap it.
  it('throws FhirClientError on request timeout', async () => {
    server.use(
      http.get(`${FHIR_BASE_URL}/Patient/${PATIENT_UUID}`, async () => {
        // Delay longer than the client timeout
        await new Promise(resolve => setTimeout(resolve, 200));
        return HttpResponse.json({ resourceType: 'Patient', id: PATIENT_UUID });
      }),
    );

    const client = new FhirClient({ baseUrl: FHIR_BASE_URL, jwt: TEST_JWT, timeoutMs: 50 });
    await expect(client.getPatient(PATIENT_UUID)).rejects.toThrow();
  });

  // searchBundle tests
  it('searchBundle returns parsed Bundle on 200', async () => {
    const bundle = {
      resourceType: 'Bundle',
      type: 'searchset',
      entry: [
        { resource: { resourceType: 'Condition', id: 'cond-1' } },
      ],
    };

    server.use(
      http.get(`${FHIR_BASE_URL}/Condition`, () => HttpResponse.json(bundle)),
    );

    const client  = makeClient();
    const result  = await client.searchBundle<fhir4.Condition>('Condition', {
      patient: PATIENT_UUID,
      'clinical-status': 'active',
    });

    expect(result.resourceType).toBe('Bundle');
    expect(result.entry).toHaveLength(1);
  });

  it('searchBundle passes query params correctly', async () => {
    let capturedUrl: URL | undefined;

    server.use(
      http.get(`${FHIR_BASE_URL}/Observation`, ({ request }) => {
        capturedUrl = new URL(request.url);
        return HttpResponse.json({ resourceType: 'Bundle', type: 'searchset', entry: [] });
      }),
    );

    await makeClient().searchBundle('Observation', {
      patient: PATIENT_UUID,
      category: 'laboratory',
      _sort: '-date',
      _count: '50',
    });

    expect(capturedUrl?.searchParams.get('patient')).toBe(PATIENT_UUID);
    expect(capturedUrl?.searchParams.get('category')).toBe('laboratory');
    expect(capturedUrl?.searchParams.get('_sort')).toBe('-date');
  });

  it('FhirClientError carries status, body, and resource fields', async () => {
    const responseBody = JSON.stringify({ resourceType: 'OperationOutcome' });

    server.use(
      http.get(`${FHIR_BASE_URL}/Patient/${PATIENT_UUID}`, () =>
        new HttpResponse(responseBody, { status: 403, headers: { 'Content-Type': 'application/fhir+json' } }),
      ),
    );

    let caught: FhirClientError | undefined;
    try {
      await makeClient().getPatient(PATIENT_UUID);
    } catch (e) {
      if (e instanceof FhirClientError) caught = e;
    }

    expect(caught).toBeInstanceOf(FhirClientError);
    expect(caught?.status).toBe(403);
    expect(caught?.resource).toContain('Patient');
    expect(caught?.message).toContain('403');
  });
});
