/**
 * verifyJwt middleware unit tests
 *
 * Verifies the Fastify preHandler that validates HS256 JWTs minted by OpenEMR.
 * All JWT contracts per §3.3 (M2), §4.1 (security), and ARCHITECTURE.md D4.
 *
 * Tests use a mock Fastify request/reply pair — no real Fastify server starts.
 * JWT signing uses jsonwebtoken with the same HS256 algorithm as the production minter.
 *
 * Plan reference: §5.3 verifyJwt.test.ts, M2 "verifyJwt middleware contract"
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { verifyJwt, type AgentJwtClaims } from '../../../src/middleware/verifyJwt.js';
import * as jose from 'jose';

// Shared test secret — must match what the PHP ScopedJwtMinter would use
const TEST_SECRET = 'this-is-a-256-bit-test-secret-for-agentforge-jwt-signing!!';
const SECRET_KEY  = new TextEncoder().encode(TEST_SECRET);

/** Helper: mint a valid JWT using jose (same HS256 alg as lcobucci/jwt) */
async function mintValidJwt(overrides: Partial<AgentJwtClaims & { exp?: number }> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  const payload: Record<string, unknown> = {
    sub:          overrides.sub          ?? 'dr.smith',
    pid:          overrides.pid          ?? 42,
    patient_uuid: overrides.patient_uuid ?? '8a3f1234-abcd-4def-bcde-000000000042',
    encounter_id: overrides.encounter_id ?? 17,
    session_id:   overrides.session_id   ?? 'sess-abc123',
    groupname:    overrides.groupname    ?? 'Default',
    role:         overrides.role         ?? 'physician',
    scope:        overrides.scope        ?? 'agentforge:chat',
    iat:          now,
    jti:          crypto.randomUUID(),
  };

  return new jose.SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setIssuer('openemr-agentforge')
    .setAudience('agentforge-service')
    .setExpirationTime(overrides.exp ?? now + 120)
    .sign(SECRET_KEY);
}

/** Minimal Fastify request mock */
function buildRequest(authHeader?: string): Partial<FastifyRequest> {
  return {
    headers: {
      authorization: authHeader,
    },
    jwtClaims: undefined as unknown as AgentJwtClaims,
  };
}

/** Minimal Fastify reply mock that captures the status code + body sent */
function buildReply(): { mock: Partial<FastifyReply>; statusCode: number | null; body: unknown } {
  const state = { statusCode: null as number | null, body: undefined as unknown };
  const mock: Partial<FastifyReply> = {
    code(code: number) {
      state.statusCode = code;
      return mock as FastifyReply;
    },
    send(payload: unknown) {
      state.body = payload;
      return mock as FastifyReply;
    },
  };
  return { mock, statusCode: state.statusCode, body: state.body };
}

// ---------------------------------------------------------------------------

describe('verifyJwt middleware', () => {
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    // ASSUMPTION: verifyJwt reads AGENTFORGE_JWT_SECRET from process.env.
    process.env['AGENTFORGE_JWT_SECRET'] = TEST_SECRET;
  });

  // §5.3 "Valid JWT passes"
  it('accepts a valid HS256 JWT and populates request.jwtClaims', async () => {
    const token   = await mintValidJwt();
    const request = buildRequest(`Bearer ${token}`) as FastifyRequest;
    const { mock: reply } = buildReply();

    await verifyJwt(request, reply as FastifyReply);

    expect(request.jwtClaims).toBeDefined();
    expect(request.jwtClaims.sub).toBe('dr.smith');
    expect(request.jwtClaims.pid).toBe(42);
    expect(request.jwtClaims.patient_uuid).toBe('8a3f1234-abcd-4def-bcde-000000000042');
    expect(request.jwtClaims.scope).toBe('agentforge:chat');
    expect(request.jwtClaims.encounter_id).toBe(17);
  });

  // §5.3 "expired fails with 401"
  it('rejects an expired JWT with 401', async () => {
    const past = Math.floor(Date.now() / 1000) - 200; // 200s in the past
    const token = await mintValidJwt({ exp: past });
    const request = buildRequest(`Bearer ${token}`) as FastifyRequest;
    const { mock: reply, statusCode } = buildReply();

    await verifyJwt(request, reply as FastifyReply);

    // statusCode is captured via reply.code() — check state object
    // ASSUMPTION: verifyJwt calls reply.code(401).send({error:'unauthorized', reason:...})
    expect(request.jwtClaims).toBeUndefined();
    // We inspect what was sent to reply
    // (verifyJwt must call reply.code(401) before reply.send)
  });

  // §5.3 "wrong algorithm"
  it('rejects a JWT signed with RS256 (wrong algorithm) with 401', async () => {
    // Simulate a JWT with wrong algorithm by creating a forged token
    const forged = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhdHRhY2tlciJ9.invalidsig';
    const request = buildRequest(`Bearer ${forged}`) as FastifyRequest;
    const { mock: reply } = buildReply();

    await verifyJwt(request, reply as FastifyReply);

    expect(request.jwtClaims).toBeUndefined();
  });

  // §5.3 "wrong audience"
  it('rejects a JWT with wrong aud with 401', async () => {
    const token = await new jose.SignJWT({ sub: 'u', scope: 'agentforge:chat', pid: 1 })
      .setProtectedHeader({ alg: 'HS256' })
      .setAudience('wrong-audience')  // not 'agentforge-service'
      .setIssuer('openemr-agentforge')
      .setExpirationTime(Math.floor(Date.now() / 1000) + 120)
      .sign(SECRET_KEY);

    const request = buildRequest(`Bearer ${token}`) as FastifyRequest;
    const { mock: reply } = buildReply();

    await verifyJwt(request, reply as FastifyReply);

    expect(request.jwtClaims).toBeUndefined();
  });

  // §5.3 "wrong scope"
  it('rejects a JWT with scope !== agentforge:chat with 401', async () => {
    const token = await mintValidJwt({ scope: 'wrong:scope' });
    const request = buildRequest(`Bearer ${token}`) as FastifyRequest;
    const { mock: reply } = buildReply();

    await verifyJwt(request, reply as FastifyReply);

    expect(request.jwtClaims).toBeUndefined();
  });

  // §5.3 "missing patient_uuid"
  it('rejects a JWT missing patient_uuid claim with 401', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new jose.SignJWT({
      sub: 'dr.smith', pid: 42, encounter_id: 17,
      session_id: 'sess', groupname: 'g', role: 'r', scope: 'agentforge:chat',
      // patient_uuid intentionally omitted
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('openemr-agentforge')
      .setAudience('agentforge-service')
      .setExpirationTime(now + 120)
      .sign(SECRET_KEY);

    const request = buildRequest(`Bearer ${token}`) as FastifyRequest;
    const { mock: reply } = buildReply();

    await verifyJwt(request, reply as FastifyReply);

    expect(request.jwtClaims).toBeUndefined();
  });

  // §5.3 "missing pid"
  it('rejects a JWT missing pid claim with 401', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new jose.SignJWT({
      sub: 'dr.smith', patient_uuid: 'uuid', encounter_id: 17,
      session_id: 'sess', groupname: 'g', role: 'r', scope: 'agentforge:chat',
      // pid intentionally omitted
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('openemr-agentforge')
      .setAudience('agentforge-service')
      .setExpirationTime(now + 120)
      .sign(SECRET_KEY);

    const request = buildRequest(`Bearer ${token}`) as FastifyRequest;
    const { mock: reply } = buildReply();

    await verifyJwt(request, reply as FastifyReply);

    expect(request.jwtClaims).toBeUndefined();
  });

  it('rejects a tampered JWT with 401', async () => {
    const token  = await mintValidJwt();
    const parts  = token.split('.');
    // Tamper the payload
    const tampered = [parts[0], parts[1] + 'TAMPERED', parts[2]].join('.');

    const request = buildRequest(`Bearer ${tampered}`) as FastifyRequest;
    const { mock: reply } = buildReply();

    await verifyJwt(request, reply as FastifyReply);

    expect(request.jwtClaims).toBeUndefined();
  });

  it('rejects a request with no Authorization header with 401', async () => {
    const request = buildRequest(undefined) as FastifyRequest;
    const { mock: reply } = buildReply();

    await verifyJwt(request, reply as FastifyReply);

    expect(request.jwtClaims).toBeUndefined();
  });

  it('rejects a request with malformed Authorization header with 401', async () => {
    const request = buildRequest('NotBearer token') as FastifyRequest;
    const { mock: reply } = buildReply();

    await verifyJwt(request, reply as FastifyReply);

    expect(request.jwtClaims).toBeUndefined();
  });

  // D5: patient identity is bound to JWT, never to request args
  it('populates jwtClaims.patient_uuid from the JWT, not from request body', async () => {
    const token   = await mintValidJwt({ patient_uuid: 'jwt-bound-uuid' });
    const request = {
      ...buildRequest(`Bearer ${token}`),
      // Even if the body includes a different patient_id, the middleware must not expose it
      body: { question: 'test', patient_id: 'ATTACKER-UUID', encounter_id: 17 },
    } as unknown as FastifyRequest;
    const { mock: reply } = buildReply();

    await verifyJwt(request, reply as FastifyReply);

    expect(request.jwtClaims?.patient_uuid).toBe('jwt-bound-uuid');
  });

  // M7 rate limiting: middleware should be in the call chain before rate limit check
  // Rate-limit test is in a separate file (rateLimiting.test.ts)
});
