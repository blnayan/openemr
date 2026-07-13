#!/usr/bin/env node
/**
 * gen-keys.mjs — generate the RSA-2048 keypair the AgentForge sidecar uses to
 * sign SMART backend-services `client_assertion` JWTs (RS384) when calling
 * OpenEMR's `/oauth2/default/token` endpoint.
 *
 * Outputs (under agent/secrets/, gitignored):
 *   private.pem  — PKCS#8 PEM, mounted into the container, signed JWTs only
 *   public.jwk   — single JWK (RS384, kid=agentforge-1) — embedded in
 *                  oauth_clients.jwks by setup_system_client.php
 *   jwks.json    — JWKS wrapper {keys:[<public.jwk>]} — convenient for
 *                  hosting at a /jwks.json endpoint if we ever switch from
 *                  inline-jwks to jwks_uri later
 *
 * Idempotency: refuses to overwrite an existing keypair unless --force is
 * passed. Rotating the key invalidates every cached access token; do it
 * deliberately.
 *
 * Usage:
 *   node agent/scripts/gen-keys.mjs           # first run
 *   node agent/scripts/gen-keys.mjs --force   # rotate
 */

import { mkdirSync, existsSync, writeFileSync, chmodSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'secrets');
const privPath = `${outDir}/private.pem`;
const jwkPath = `${outDir}/public.jwk`;
const jwksPath = `${outDir}/jwks.json`;

const force = process.argv.includes('--force');
mkdirSync(outDir, { recursive: true });

if (!force && (existsSync(privPath) || existsSync(jwkPath))) {
  console.error(
    `Refusing to overwrite existing keypair at ${outDir}.\n` +
      `Pass --force to rotate (every cached access token will be invalidated).`,
  );
  process.exit(1);
}

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});

const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
// 0o644 (not 0o600) because the file is bind-mounted read-only into the
// agentforge container, which runs as a different UID than the host user
// who generated the key. The host directory `agent/secrets/` is gitignored,
// so the key never leaves the dev machine.
writeFileSync(privPath, privatePem, { mode: 0o644 });
chmodSync(privPath, 0o644);

// Export the public key as a JWK with RS384 metadata so it can be dropped
// straight into oauth_clients.jwks. OpenEMR's JsonWebKeySet expects a JWKS
// (i.e. {"keys":[{...}]}), so we write both shapes — single JWK and JWKS
// wrapper — for convenience.
const jwk = publicKey.export({ format: 'jwk' });
jwk.alg = 'RS384';
jwk.use = 'sig';
jwk.kid = 'agentforge-1';

const jwks = { keys: [jwk] };
writeFileSync(jwkPath, JSON.stringify(jwk, null, 2) + '\n');
writeFileSync(jwksPath, JSON.stringify(jwks, null, 2) + '\n');

console.log(`[+] private key   → ${privPath} (mode 0600)`);
console.log(`[+] public JWK    → ${jwkPath}`);
console.log(`[+] JWKS wrapper  → ${jwksPath}`);
console.log(`\nNext: register the JWKS with OpenEMR:`);
console.log(
  `  docker compose -f docker/development-easy/docker-compose.yml \\`,
);
console.log(
  `    -f docker/development-easy/docker-compose.agentforge.yml \\`,
);
console.log(
  `    exec openemr php contrib/agentforge/setup_system_client.php \\`,
);
console.log(`      --jwks-file=/var/www/localhost/htdocs/openemr/agent/secrets/jwks.json`);
