/**
 * verifyJwt — Fastify preHandler. Validates the HS256 JWT minted by the
 * OpenEMR ScopedJwtMinter and binds the parsed claims to request.jwtClaims.
 *
 * Per D5 the patient identity (pid + patient_uuid) lives in the JWT, never
 * in tool arguments. The middleware enforces presence of those claims.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import * as jose from 'jose';

export interface AgentJwtClaims {
  sub: string;
  pid: number;
  patient_uuid: string;
  encounter_id: number | null;
  session_id: string;
  groupname: string;
  role: string;
  scope: string;
  exp: number;
  iat: number;
  jti: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    jwtClaims: AgentJwtClaims;
  }
}

const ISSUER = 'openemr-agentforge';
const AUDIENCE = 'agentforge-service';
const REQUIRED_SCOPE = 'agentforge:chat';

export async function verifyJwt(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const secret = process.env['AGENTFORGE_JWT_SECRET'];
  // HS256 with a short shared secret is brute-forceable. Reject configs that
  // aren't long enough to give the HMAC meaningful entropy. 32 bytes matches
  // the SHA-256 output width and the convention used by the PHP minter.
  if (!secret || secret.length < 32) {
    reply.code(500).send({ error: 'server_misconfigured', reason: 'missing_jwt_secret' });
    return;
  }

  const authHeader = request.headers?.authorization;
  if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    reply.code(401).send({ error: 'unauthorized', reason: 'missing_bearer_token' });
    return;
  }

  const token = authHeader.slice('Bearer '.length).trim();
  if (token === '') {
    reply.code(401).send({ error: 'unauthorized', reason: 'empty_token' });
    return;
  }

  const key = new TextEncoder().encode(secret);

  try {
    const { payload } = await jose.jwtVerify(token, key, {
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: AUDIENCE,
    });

    if (payload['scope'] !== REQUIRED_SCOPE) {
      reply.code(401).send({ error: 'unauthorized', reason: 'invalid_scope' });
      return;
    }

    if (typeof payload['patient_uuid'] !== 'string' || payload['patient_uuid'] === '') {
      reply.code(401).send({ error: 'unauthorized', reason: 'missing_patient_uuid' });
      return;
    }

    if (typeof payload['pid'] !== 'number' || !Number.isInteger(payload['pid']) || payload['pid'] <= 0) {
      reply.code(401).send({ error: 'unauthorized', reason: 'missing_pid' });
      return;
    }

    request.jwtClaims = {
      sub: String(payload['sub'] ?? ''),
      pid: payload['pid'] as number,
      patient_uuid: payload['patient_uuid'] as string,
      encounter_id: typeof payload['encounter_id'] === 'number' ? payload['encounter_id'] as number : null,
      session_id: String(payload['session_id'] ?? ''),
      groupname: String(payload['groupname'] ?? ''),
      role: String(payload['role'] ?? ''),
      scope: payload['scope'] as string,
      exp: typeof payload.exp === 'number' ? payload.exp : 0,
      iat: typeof payload.iat === 'number' ? payload.iat : 0,
      jti: String(payload['jti'] ?? ''),
    };
  } catch (err) {
    // request.log is always present in production; guard for unit tests
    // that hand-roll a minimal request stub.
    request.log?.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'agentforge.verifyJwt rejected token',
    );
    reply.code(401).send({ error: 'unauthorized', reason: 'invalid_token' });
  }
}
