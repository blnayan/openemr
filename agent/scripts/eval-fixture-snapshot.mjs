#!/usr/bin/env node
/**
 * eval-fixture-snapshot.mjs — capture a one-shot chart snapshot from
 * the live OpenEMR FHIR endpoint into a fixture JSON the eval suite
 * can replay against.
 *
 * The promptfoo gated suite normally hits the running agent service
 * at :3030, which calls FhirClient → real OpenEMR → real MariaDB.
 * That makes evals non-deterministic and DB-state-dependent. This
 * script + FixtureToolDispatcher break that dependency: snapshot
 * once, run evals N times against the frozen JSON.
 *
 * Workflow:
 *   1. (one-time)
 *        node scripts/eval-fixture-snapshot.mjs \
 *            --pid 1 \
 *            --patient-uuid a1be5a96-ad05-4850-b9eb-168c08b55297 \
 *            --out evals/fixtures/chart-snapshot.json
 *   2. Set AGENTFORGE_EVAL_FIXTURE_PATH=evals/fixtures/chart-snapshot.json
 *      and (re)start the agent.
 *   3. Run `npm run eval` — the agent's TOOL_REGISTRY is now wired to
 *      the snapshot; no FHIR / DB traffic on chart-tool calls.
 *
 * Re-snapshot only when chart data changes intentionally. The fixture
 * is committed to git so CI runs are byte-stable.
 *
 * Inputs (env or flags):
 *   --pid              OpenEMR patient pid (numeric). Required.
 *   --patient-uuid     FHIR Patient.id for the same patient. Required.
 *   --out              Output path. Default: evals/fixtures/chart-snapshot.json.
 *   --description      Freeform description embedded in the fixture.
 *
 *   AGENTFORGE_JWT_SECRET   Required (mints the FhirClient JWT).
 *   OPENEMR_FHIR_BASE_URL   Required (where the snapshot reads from).
 *   OPENEMR_FHIR_TLS_INSECURE  "1" to relax cert verify (localhost dev).
 *
 * Output JSON shape — see src/eval/FixtureToolDispatcher.ts for the
 * companion validator.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Tools are TS modules; tsx (the runner) compiles them on the fly.
import { TOOLS } from '../src/tools/index.ts';
import { FhirClient } from '../src/fhir/FhirClient.ts';
import { OpenEmrTokenProvider } from '../src/fhir/OpenEmrTokenProvider.ts';

const FIXTURE_BACKED = new Set([
  'get_patient_summary',
  'get_active_problems',
  'get_medications',
  'get_recent_labs',
  'get_vitals',
  'get_allergies',
  'get_recent_encounters',
]);

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`error: env ${name} is required`);
    process.exit(1);
  }
  return v;
}

async function main() {
  const args = parseArgs(process.argv);
  const pid = Number(args.pid ?? requireEnv('EVAL_PID'));
  const patientUuid = String(args['patient-uuid'] ?? requireEnv('EVAL_PATIENT_UUID'));
  const outRel = String(args.out ?? 'evals/fixtures/chart-snapshot.json');
  const description = typeof args.description === 'string'
    ? args.description
    : `Chart snapshot for pid=${pid} (${patientUuid})`;

  if (!Number.isInteger(pid) || pid <= 0) {
    console.error(`error: --pid must be a positive integer (got ${args.pid})`);
    process.exit(1);
  }

  // FhirClient needs a SMART backend-services OAuth bearer token, NOT the
  // inter-service AGENTFORGE_JWT_SECRET. OpenEmrTokenProvider runs the
  // client_assertion → /token dance the production agent uses.
  const fhirBaseUrl = requireEnv('OPENEMR_FHIR_BASE_URL');
  const tlsInsecure = process.env.OPENEMR_FHIR_TLS_INSECURE === '1';
  const tokenProvider = new OpenEmrTokenProvider(process.env);
  if (!tokenProvider.isConfigured()) {
    console.error(
      'error: OpenEmrTokenProvider not configured. Need OPENEMR_OAUTH_BASE_URL, '
      + 'OPENEMR_FHIR_CLIENT_ID, and OPENEMR_FHIR_PRIVATE_KEY_PATH (or _PEM).',
    );
    process.exit(1);
  }
  const oauthBearer = await tokenProvider.getToken();

  const fhirClient = new FhirClient({ baseUrl: fhirBaseUrl, jwt: oauthBearer, tlsInsecure });
  const ctx = { patientUuid, pid, jwt: oauthBearer, fhirClient };

  console.log(`[eval-snapshot] capturing pid=${pid} (${patientUuid}) from ${fhirBaseUrl}`);

  const tools = {};
  let failures = 0;
  for (const tool of TOOLS) {
    if (!FIXTURE_BACKED.has(tool.name)) continue;
    try {
      const result = await tool.execute({}, ctx);
      tools[tool.name] = result;
      const summary = result.ok
        ? `ok rows=${result.rows.length}${result.degraded ? ' (degraded)' : ''}`
        : `error reason="${result.reason}"`;
      console.log(`  ✓ ${tool.name.padEnd(24)} ${summary}`);
    } catch (err) {
      failures += 1;
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ ${tool.name.padEnd(24)} threw: ${reason}`);
      tools[tool.name] = { ok: false, tool: tool.name, reason };
    }
  }

  const payload = {
    patient_uuid: patientUuid,
    description,
    captured_at: new Date().toISOString(),
    tools,
  };

  const outPath = resolve(process.cwd(), outRel);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n');
  console.log(`\n[eval-snapshot] wrote ${outPath}`);
  if (failures > 0) {
    console.warn(`[eval-snapshot] ${failures} tool(s) threw — fixture will replay those errors verbatim.`);
  }
}

main().catch(err => {
  console.error('[eval-snapshot] failed:', err);
  process.exit(1);
});
