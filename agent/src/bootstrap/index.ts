/**
 * Bootstrap module — runs once at server start, before app.listen().
 *
 * Responsibilities:
 *   1. Validate optional env vars and log operator-facing gaps.
 *   2. Poll OpenEMR for readiness with exponential backoff. Cap at ~90 s
 *      total — past that we log a warning and continue, so a flaky
 *      OpenEMR doesn't pin the agent service in a restart loop.
 *   3. Conditionally run the (idempotent) guideline ingest into Pinecone
 *      when AGENTFORGE_GUIDELINES_INGEST=1. Idempotency check: query
 *      Pinecone for current chunk count and skip if it matches the
 *      committed corpus size.
 *   4. Conditionally run the demo-fixture ingest when
 *      AGENTFORGE_FIXTURE_INGEST=1. Idempotency check: skip when the
 *      sidecar already has rows for the demo pubpid prefix.
 *   5. Auto-set both ingest gates when RAILWAY_ENVIRONMENT is non-empty
 *      (mirrors the Synthea seeder gate in auto_configure.php) so a
 *      fresh Railway deploy boots into a usable demo without manual
 *      one-shot commands.
 *
 * Bootstrap failures are LOGGED, not raised. Server start always
 * proceeds. Each step's outcome is captured in BootstrapResult so the
 * server can publish status on /bootstrap-status.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

import type { AgentConfig } from '../config.js';
import type { BootstrapLogger } from './wireDeps.js';

export type BootstrapStepName =
  | 'validate_env'
  | 'openemr_readiness'
  | 'guideline_ingest'
  | 'fixture_ingest';

export interface BootstrapStepResult {
  readonly step: BootstrapStepName;
  readonly ok: boolean;
  readonly skipped?: boolean;
  readonly reason?: string;
  readonly attempts?: number;
  readonly durationMs?: number;
  readonly error?: string;
}

export interface BootstrapResult {
  readonly steps: readonly BootstrapStepResult[];
  readonly startedAt: string;
  readonly finishedAt: string;
}

/**
 * Optional dependency injection for tests. Production callers omit
 * everything except `config` + `logger` and the module wires real
 * implementations.
 */
export interface BootstrapDeps {
  readonly fetchImpl?: typeof fetch;
  readonly sleepImpl?: (ms: number) => Promise<void>;
  readonly nowImpl?: () => number;
  /**
   * Test seam for the guideline-ingest step. The real implementation
   * imports `ingestGuidelines` + `expectedChunkCount` from
   * `agent/scripts/ingest-guidelines.ts` and queries the live Pinecone
   * index for chunk count.
   */
  readonly runGuidelineIngest?: (env: NodeJS.ProcessEnv) => Promise<{
    skipped: boolean;
    reason?: string;
    pineconeUpserted: boolean;
    totalChunks: number;
  }>;
  readonly currentPineconeChunkCount?: (config: AgentConfig) => Promise<number | null>;
  readonly expectedChunkCount?: () => Promise<number>;
  /** Test seam for the fixture-ingest step. */
  readonly runFixtureIngest?: (env: NodeJS.ProcessEnv) => Promise<{
    skipped: boolean;
    reason?: string;
  }>;
  readonly demoFixturesAlreadyPresent?: (
    config: AgentConfig,
    env: NodeJS.ProcessEnv,
  ) => Promise<boolean>;
}

const READINESS_MAX_ATTEMPTS = 30;
const READINESS_BACKOFF_MIN_MS = 1000;
const READINESS_BACKOFF_MAX_MS = 5000;
/** PRD-defined demo pubpid prefix (issue 15). */
const DEMO_PUBPID_PREFIX = 'AGENTFORGE-DEMO-PDF-';

/**
 * Apply the Railway auto-set rule to the env: when RAILWAY_ENVIRONMENT
 * is non-empty AND a gate var is unset, default it to "1". Operator
 * override (gate=0 or any other value) always wins. Mirrors the
 * three-way resolver in auto_configure.php.
 */
function applyRailwayAutoGates(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const railwayEnv = env['RAILWAY_ENVIRONMENT'];
  if (!railwayEnv) return env;
  const next = { ...env };
  if (next['AGENTFORGE_GUIDELINES_INGEST'] === undefined
      || next['AGENTFORGE_GUIDELINES_INGEST'] === '') {
    next['AGENTFORGE_GUIDELINES_INGEST'] = '1';
  }
  if (next['AGENTFORGE_FIXTURE_INGEST'] === undefined
      || next['AGENTFORGE_FIXTURE_INGEST'] === '') {
    next['AGENTFORGE_FIXTURE_INGEST'] = '1';
  }
  return next;
}

export async function runBootstrap(
  config: AgentConfig,
  logger: BootstrapLogger,
  rawEnv: NodeJS.ProcessEnv = process.env,
  deps: BootstrapDeps = {},
): Promise<BootstrapResult> {
  const env = applyRailwayAutoGates(rawEnv);
  if (env !== rawEnv && rawEnv['RAILWAY_ENVIRONMENT']) {
    logger.info(
      { railway_env: rawEnv['RAILWAY_ENVIRONMENT'] },
      '[agentforge.bootstrap] Railway detected — auto-enabling ingest gates',
    );
  }

  const startedAt = new Date().toISOString();
  const steps: BootstrapStepResult[] = [];

  // -------- 1. validate env --------
  const validateStep = await runStep('validate_env', async () => {
    // Soft-warn the optional vars.
    const optionals: Array<readonly [string, string]> = [
      ['OPENROUTER_API_KEY', 'LLM completions disabled'],
      ['PINECONE_API_KEY', 'guideline retrieval disabled'],
      ['LANGFUSE_SECRET_KEY', 'observability traces will not ship'],
      ['LANGFUSE_PUBLIC_KEY', 'observability traces will not ship'],
    ];
    for (const [key, gap] of optionals) {
      if (!env[key]) {
        logger.warn({ env_var: key, gap },
          `[agentforge.bootstrap] optional env var unset — ${gap}`);
      }
    }
  }, deps.nowImpl);

  steps.push(validateStep);
  if (!validateStep.ok) {
    logger.error({ step: 'validate_env', error: validateStep.error },
      '[agentforge.bootstrap] env validation failed — server will start but features may be broken');
  }

  // -------- 2. openemr readiness --------
  if (env['AGENTFORGE_BOOTSTRAP_SKIP_OPENEMR_PROBE'] === '1') {
    steps.push({
      step: 'openemr_readiness',
      ok: true,
      skipped: true,
      reason: 'AGENTFORGE_BOOTSTRAP_SKIP_OPENEMR_PROBE=1',
    });
  } else {
    steps.push(await pollOpenEmrReadiness(config, logger, deps));
  }

  // -------- 3. guideline ingest --------
  steps.push(await runGuidelineIngestStep(config, logger, env, deps));

  // -------- 4. fixture ingest --------
  steps.push(await runFixtureIngestStep(config, logger, env, deps));

  const finishedAt = new Date().toISOString();
  return { steps, startedAt, finishedAt };
}

// ---------------------------------------------------------------------------
// Step helpers
// ---------------------------------------------------------------------------

async function runStep(
  step: BootstrapStepName,
  fn: () => Promise<void>,
  nowImpl?: () => number,
): Promise<BootstrapStepResult> {
  const now = nowImpl ?? Date.now;
  const t0 = now();
  try {
    await fn();
    return { step, ok: true, durationMs: now() - t0 };
  } catch (err) {
    return {
      step,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: now() - t0,
    };
  }
}

async function pollOpenEmrReadiness(
  config: AgentConfig,
  logger: BootstrapLogger,
  deps: BootstrapDeps,
): Promise<BootstrapStepResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleepImpl = deps.sleepImpl ?? defaultSleep;
  const now = deps.nowImpl ?? Date.now;
  const url = deriveMetadataUrl(config.OPENEMR_FHIR_BASE_URL);
  const t0 = now();
  let lastError: string | undefined;
  for (let attempt = 1; attempt <= READINESS_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetchImpl(url, { method: 'GET' });
      if (res.ok || res.status === 401 || res.status === 403) {
        // 4xx auth challenges still mean the service is up.
        logger.info({ url, attempt, status: res.status },
          '[agentforge.bootstrap] OpenEMR ready');
        return {
          step: 'openemr_readiness',
          ok: true,
          attempts: attempt,
          durationMs: now() - t0,
        };
      }
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (attempt < READINESS_MAX_ATTEMPTS) {
      const wait = Math.min(
        READINESS_BACKOFF_MIN_MS * Math.pow(1.2, attempt - 1),
        READINESS_BACKOFF_MAX_MS,
      );
      await sleepImpl(wait);
    }
  }
  logger.warn(
    { url, attempts: READINESS_MAX_ATTEMPTS, last_error: lastError },
    '[agentforge.bootstrap] OpenEMR did not become ready within budget; continuing',
  );
  return {
    step: 'openemr_readiness',
    ok: false,
    attempts: READINESS_MAX_ATTEMPTS,
    error: lastError ?? 'unknown',
    durationMs: now() - t0,
  };
}

function deriveMetadataUrl(fhirBase: string): string {
  const trimmed = fhirBase.replace(/\/$/, '');
  return `${trimmed}/metadata`;
}

async function runGuidelineIngestStep(
  config: AgentConfig,
  logger: BootstrapLogger,
  env: NodeJS.ProcessEnv,
  deps: BootstrapDeps,
): Promise<BootstrapStepResult> {
  const t0 = (deps.nowImpl ?? Date.now)();
  if (env['AGENTFORGE_GUIDELINES_INGEST'] !== '1') {
    return {
      step: 'guideline_ingest',
      ok: true,
      skipped: true,
      reason: 'AGENTFORGE_GUIDELINES_INGEST != 1',
      durationMs: (deps.nowImpl ?? Date.now)() - t0,
    };
  }
  if (!config.PINECONE_API_KEY) {
    return {
      step: 'guideline_ingest',
      ok: true,
      skipped: true,
      reason: 'PINECONE_API_KEY unset',
      durationMs: (deps.nowImpl ?? Date.now)() - t0,
    };
  }
  try {
    // Idempotency: compare live chunk count vs expected. Skip if equal.
    const expected = await (deps.expectedChunkCount ?? defaultExpectedChunkCount)();
    const live = await (deps.currentPineconeChunkCount ?? defaultPineconeChunkCount)(config);
    if (live !== null && live === expected && expected > 0) {
      logger.info(
        { index: config.PINECONE_INDEX_NAME, chunks: live },
        '[agentforge.bootstrap] guideline ingest skipped — index already at expected chunk count',
      );
      return {
        step: 'guideline_ingest',
        ok: true,
        skipped: true,
        reason: `idempotent: index already has ${live} chunks (expected ${expected})`,
        durationMs: (deps.nowImpl ?? Date.now)() - t0,
      };
    }
    const result = await (deps.runGuidelineIngest ?? defaultRunGuidelineIngest)(env);
    logger.info(
      { result },
      '[agentforge.bootstrap] guideline ingest complete',
    );
    return {
      step: 'guideline_ingest',
      ok: true,
      skipped: result.skipped,
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
      durationMs: (deps.nowImpl ?? Date.now)() - t0,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      { error: message },
      '[agentforge.bootstrap] guideline ingest failed (non-fatal); continuing',
    );
    return {
      step: 'guideline_ingest',
      ok: false,
      error: message,
      durationMs: (deps.nowImpl ?? Date.now)() - t0,
    };
  }
}

async function runFixtureIngestStep(
  config: AgentConfig,
  logger: BootstrapLogger,
  env: NodeJS.ProcessEnv,
  deps: BootstrapDeps,
): Promise<BootstrapStepResult> {
  const t0 = (deps.nowImpl ?? Date.now)();
  if (env['AGENTFORGE_FIXTURE_INGEST'] !== '1') {
    return {
      step: 'fixture_ingest',
      ok: true,
      skipped: true,
      reason: 'AGENTFORGE_FIXTURE_INGEST != 1',
      durationMs: (deps.nowImpl ?? Date.now)() - t0,
    };
  }
  try {
    const present = await (deps.demoFixturesAlreadyPresent
      ?? defaultDemoFixturesAlreadyPresent)(config, env);
    if (present) {
      logger.info(
        { prefix: DEMO_PUBPID_PREFIX },
        '[agentforge.bootstrap] fixture ingest skipped — demo sidecar rows already present',
      );
      return {
        step: 'fixture_ingest',
        ok: true,
        skipped: true,
        reason: `idempotent: sidecar rows for ${DEMO_PUBPID_PREFIX} already present`,
        durationMs: (deps.nowImpl ?? Date.now)() - t0,
      };
    }
    const result = await (deps.runFixtureIngest ?? defaultRunFixtureIngest)(env);
    logger.info({ result }, '[agentforge.bootstrap] fixture ingest complete');
    return {
      step: 'fixture_ingest',
      ok: true,
      skipped: result.skipped,
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
      durationMs: (deps.nowImpl ?? Date.now)() - t0,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      { error: message },
      '[agentforge.bootstrap] fixture ingest failed (non-fatal); continuing',
    );
    return {
      step: 'fixture_ingest',
      ok: false,
      error: message,
      durationMs: (deps.nowImpl ?? Date.now)() - t0,
    };
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function defaultExpectedChunkCount(): Promise<number> {
  const mod = await import('../../scripts/ingest-guidelines.js');
  return mod.expectedChunkCount();
}

async function defaultPineconeChunkCount(config: AgentConfig): Promise<number | null> {
  if (!config.PINECONE_API_KEY) return null;
  try {
    const { Pinecone } = await import('@pinecone-database/pinecone');
    const pinecone = new Pinecone({ apiKey: config.PINECONE_API_KEY });
    const stats = await pinecone.index(config.PINECONE_INDEX_NAME).describeIndexStats();
    // describeIndexStats returns `totalRecordCount` (or `totalVectorCount`
    // on older SDKs); take whichever is present.
    const total = (stats as { totalRecordCount?: number; totalVectorCount?: number })
      .totalRecordCount
      ?? (stats as { totalVectorCount?: number }).totalVectorCount
      ?? 0;
    return total;
  } catch {
    // 404 (index not yet created), network blip, etc. Return null so
    // the caller falls through to the actual ingest.
    return null;
  }
}

async function defaultRunGuidelineIngest(env: NodeJS.ProcessEnv): Promise<{
  skipped: boolean;
  reason?: string;
  pineconeUpserted: boolean;
  totalChunks: number;
}> {
  const mod = await import('../../scripts/ingest-guidelines.js');
  return mod.ingestGuidelines(env);
}

async function defaultRunFixtureIngest(env: NodeJS.ProcessEnv): Promise<{
  skipped: boolean;
  reason?: string;
}> {
  // Fixture ingest currently lives in a `.mjs` script that shells out
  // to PHP and posts uploads. From inside the agent service we do not
  // have PHP available, so we shell out to `node` to invoke the
  // committed seeder script. When the script is missing or fails to
  // spawn, return a structured skip rather than throwing — the
  // bootstrap caller is non-fatal either way.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const path = await import('node:path');
  const url = await import('node:url');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const script = path.resolve(here, '..', '..', 'scripts', 'seed-demo-fixtures.mjs');
  const fs = await import('node:fs');
  if (!fs.existsSync(script)) {
    return { skipped: true, reason: `seed-demo-fixtures.mjs missing at ${script}` };
  }
  const exec = promisify(execFile);
  await exec(process.execPath, [script], {
    env: env as NodeJS.ProcessEnv,
  });
  return { skipped: false };
}

async function defaultDemoFixturesAlreadyPresent(
  _config: AgentConfig,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  // Best-effort idempotency check via the sidecar.php endpoint. The
  // demo seeder uses pubpid prefix AGENTFORGE-DEMO-PDF-001 / -002 —
  // pid mapping isn't stable across deploys, so we ask the OpenEMR
  // sidecar whether *any* row exists for the demo prefix. If the
  // endpoint isn't reachable yet, return false so the caller proceeds
  // with the actual ingest (which is itself idempotent on pubpid).
  const baseUrl = env['OPENEMR_BASE_URL'] ?? env['OPENEMR_SIDECAR_BASE_URL'];
  if (!baseUrl) return false;
  try {
    const trimmed = baseUrl.replace(/\/$/, '');
    const url = `${trimmed}/interface/agentforge/sidecar.php?demo_prefix=${encodeURIComponent(DEMO_PUBPID_PREFIX)}`;
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) return false;
    const body = await res.json() as { count?: number } | unknown;
    if (body && typeof body === 'object' && 'count' in body) {
      const count = (body as { count?: number }).count;
      return typeof count === 'number' && count > 0;
    }
    return false;
  } catch {
    return false;
  }
}
