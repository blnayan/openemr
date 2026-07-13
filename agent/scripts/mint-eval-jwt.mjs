#!/usr/bin/env node
/**
 * Mint a 5-minute AgentForge JWT for promptfoo / curl smoke tests.
 *
 * Reads:
 *   AGENTFORGE_JWT_SECRET   — required, must match the agent's secret
 *   EVAL_PATIENT_UUID       — the seeded synthea patient's UUID (default
 *                             a1ab2982-a9ae-489e-97e1-91dd703098ad = Adrianne)
 *   EVAL_PID                — pid for the patient (default 1)
 *   EVAL_USER_SUB           — sub claim (default 'admin')
 *
 * Prints the JWT to stdout.
 */

import * as jose from 'jose';

const secret = process.env.AGENTFORGE_JWT_SECRET;
if (!secret) {
  console.error('AGENTFORGE_JWT_SECRET is required to mint an eval JWT.');
  process.exit(1);
}

const key = new TextEncoder().encode(secret);
const now = Math.floor(Date.now() / 1000);
const ttlSeconds = Number(process.env.EVAL_JWT_TTL || 300);

const jwt = await new jose.SignJWT({
  sub:          process.env.EVAL_USER_SUB ?? 'admin',
  pid:          Number(process.env.EVAL_PID ?? 1),
  patient_uuid: process.env.EVAL_PATIENT_UUID ?? 'a1ab2982-a9ae-489e-97e1-91dd703098ad',
  encounter_id: null,
  session_id:   'eval-session',
  groupname:    'Default',
  role:         'physician',
  scope:        'agentforge:chat',
  jti:          crypto.randomUUID(),
})
  .setProtectedHeader({ alg: 'HS256' })
  .setIssuer('openemr-agentforge')
  .setAudience('agentforge-service')
  .setIssuedAt(now)
  // sidecar.php validates with StrictValidAt (expects nbf); mirror the
  // PHP ScopedJwtMinter behavior and backdate slightly for clock skew.
  .setNotBefore(now - 5)
  .setExpirationTime(now + ttlSeconds)
  .sign(key);

process.stdout.write(jwt);
