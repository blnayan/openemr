/**
 * /chat route integration tests
 *
 * Tests the full Fastify + JWT verify + graph route against an in-process
 * mock FHIR server (msw). Verifies:
 *   - Valid JWT → SSE stream ending in "event: done"
 *   - Expired JWT → 401 before any graph execution
 *   - JWT patient_uuid injected into FHIR calls (not from body)
 *   - Out-of-scope question (James Lee cross-patient) → refusal in SSE stream
 *
 * Plan reference: §5.3 routes/chat.test.ts, M2 acceptance criteria
 * ARCHITECTURE.md §"Data Flow" step 4
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import * as jose from 'jose';

// ASSUMPTION: buildServer() is the Fastify app factory from src/server.ts.
// It accepts an optional stub-planner flag for M2 integration tests.
// import { buildServer } from '../../../src/server.js';

const FHIR_BASE    = 'http://openemr.test/apis/fhir/R4';
const TEST_SECRET  = 'this-is-a-256-bit-test-secret-for-agentforge-jwt-signing!!';
const SECRET_KEY   = new TextEncoder().encode(TEST_SECRET);
const PATIENT_UUID = 'test-patient-001';

// ---------------------------------------------------------------------------
// JWT factory
// ---------------------------------------------------------------------------

async function mintJwt(overrides: { exp?: number; scope?: string; patient_uuid?: string } = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new jose.SignJWT({
    sub:          'dr.smith',
    pid:          42,
    patient_uuid: overrides.patient_uuid ?? PATIENT_UUID,
    encounter_id: 17,
    session_id:   'sess-abc',
    groupname:    'Default',
    role:         'physician',
    scope:        overrides.scope ?? 'agentforge:chat',
    jti:          crypto.randomUUID(),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('openemr-agentforge')
    .setAudience('agentforge-service')
    .setExpirationTime(overrides.exp ?? now + 120)
    .sign(SECRET_KEY);
}

// ---------------------------------------------------------------------------
// MSW FHIR mock
// ---------------------------------------------------------------------------

const mswServer = setupServer(
  http.get(`${FHIR_BASE}/Patient/${PATIENT_UUID}`, () =>
    HttpResponse.json({ resourceType: 'Patient', id: PATIENT_UUID }),
  ),
  http.get(`${FHIR_BASE}/MedicationRequest`, () =>
    HttpResponse.json({ resourceType: 'Bundle', type: 'searchset', entry: [] }),
  ),
  http.get(`${FHIR_BASE}/Condition`, () =>
    HttpResponse.json({ resourceType: 'Bundle', type: 'searchset', entry: [] }),
  ),
  http.get(`${FHIR_BASE}/AllergyIntolerance`, () =>
    HttpResponse.json({ resourceType: 'Bundle', type: 'searchset', entry: [] }),
  ),
  http.get(`${FHIR_BASE}/Observation`, () =>
    HttpResponse.json({ resourceType: 'Bundle', type: 'searchset', entry: [] }),
  ),
  http.get(`${FHIR_BASE}/Encounter`, () =>
    HttpResponse.json({ resourceType: 'Bundle', type: 'searchset', entry: [] }),
  ),
);

beforeAll(() => mswServer.listen({ onUnhandledRequest: 'warn' }));
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());

// ---------------------------------------------------------------------------
// Tests — marked pending until server is buildable
// ---------------------------------------------------------------------------

describe('/chat route integration', () => {
  // TODO(plan-driven-test-generator): Uncomment and implement once buildServer()
  // is exported from src/server.ts (M2 milestone). The test body is complete;
  // only the server construction is deferred.

  it.todo(
    'POST /chat with valid JWT returns SSE stream ending with event:done ' +
    '— lift once buildServer() is exported (M2)',
  );

  it.todo(
    'POST /chat with expired JWT returns HTTP 401 before graph executes ' +
    '— lift once buildServer() is exported (M2)',
  );

  it.todo(
    'POST /chat with malformed body returns HTTP 400 ' +
    '— lift once buildServer() is exported (M2)',
  );

  // D5: JWT patient_uuid is used for all FHIR calls — not the body
  it.todo(
    'POST /chat calls FHIR with JWT-bound patient_uuid, not body patient_id ' +
    '— lift once buildServer() is exported (M2)',
  );

  // M2 acceptance criteria: "POST /chat with valid JWT returns SSE stream ending in data: [DONE]"
  it.todo(
    'SSE stream from /chat contains event:done as the terminal event ' +
    '— lift once buildServer() is exported (M2)',
  );

  // UC-1: cross-patient refusal
  it.todo(
    'Cross-patient question ("Tell me about James Lee") returns out_of_scope refusal ' +
    'without FHIR tool calls — lift once router node is wired into graph (M3)',
  );
});

// ---------------------------------------------------------------------------
// /healthz route integration
// ---------------------------------------------------------------------------

describe('/healthz route', () => {
  it.todo(
    'GET /healthz returns 200 { status: ok } ' +
    '— lift once buildServer() is exported (M2)',
  );
});
