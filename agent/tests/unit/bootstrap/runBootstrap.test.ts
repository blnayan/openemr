/**
 * Unit tests for runBootstrap — exercises the public surface (env
 * validation, OpenEMR readiness probe, gated ingests, idempotency
 * skip, error containment) without touching Pinecone, the OpenEMR
 * stack, or the seed-fixture script.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { runBootstrap, type BootstrapDeps } from '../../../src/bootstrap/index.js';
import { loadConfig, type AgentConfig } from '../../../src/config.js';

interface CapturedLog {
  readonly level: 'info' | 'warn' | 'error';
  readonly obj: object | string;
  readonly msg?: string;
}

function makeLogger(): { logs: CapturedLog[]; logger: {
  info(obj: object | string, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
  error(obj: object | string, msg?: string): void;
} } {
  const logs: CapturedLog[] = [];
  const make = (level: CapturedLog['level']) =>
    (obj: object | string, msg?: string) => {
      logs.push(msg !== undefined ? { level, obj, msg } : { level, obj });
    };
  return {
    logs,
    logger: { info: make('info'), warn: make('warn'), error: make('error') },
  };
}

const SALT = 'a'.repeat(64);

function baseEnv(over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    AGENTFORGE_JWT_SECRET: 'b'.repeat(48),
    AGENTFORGE_PHI_REDACTION_SALT: SALT,
    AGENTFORGE_BOOTSTRAP_SKIP_OPENEMR_PROBE: '1',
    ...over,
  };
}

function makeConfig(env: NodeJS.ProcessEnv): AgentConfig {
  return loadConfig(env);
}

describe('runBootstrap', () => {
  let nowCounter = 0;
  beforeEach(() => { nowCounter = 0; });
  const fakeNow = (): number => { nowCounter += 1; return nowCounter; };

  it('skips both ingests when gates are unset and logs validate_env ok', async () => {
    const env = baseEnv();
    const config = makeConfig(env);
    const { logs, logger } = makeLogger();
    const result = await runBootstrap(config, logger, env, { nowImpl: fakeNow });
    const byStep = Object.fromEntries(result.steps.map(s => [s.step, s]));
    expect(byStep['validate_env']?.ok).toBe(true);
    expect(byStep['openemr_readiness']?.skipped).toBe(true);
    expect(byStep['guideline_ingest']?.skipped).toBe(true);
    expect(byStep['guideline_ingest']?.reason).toContain('AGENTFORGE_GUIDELINES_INGEST');
    expect(byStep['fixture_ingest']?.skipped).toBe(true);
    expect(logs.some(l => String(l.msg ?? '').includes('runBootstrap'))).toBe(false);
  });

  it('keeps validate_env ok when AGENTFORGE_PHI_REDACTION_SALT is unset', async () => {
    const env = baseEnv();
    delete env['AGENTFORGE_PHI_REDACTION_SALT'];
    const config = makeConfig(env);
    const { logs, logger } = makeLogger();
    const result = await runBootstrap(config, logger, env, { nowImpl: fakeNow });
    const validate = result.steps.find(s => s.step === 'validate_env');
    expect(validate?.ok).toBe(true);
    // Server continues — other steps still ran.
    expect(result.steps.some(s => s.step === 'openemr_readiness')).toBe(true);
    expect(logs.some(l => l.level === 'error')).toBe(false);
  });

  it('runs guideline ingest when gate=1 and Pinecone count differs from expected', async () => {
    const env = baseEnv({ AGENTFORGE_GUIDELINES_INGEST: '1', PINECONE_API_KEY: 'pc-test' });
    const config = makeConfig(env);
    const { logger } = makeLogger();
    let ingestCalled = 0;
    const deps: BootstrapDeps = {
      nowImpl: fakeNow,
      currentPineconeChunkCount: async () => 100,
      expectedChunkCount: async () => 515,
      runGuidelineIngest: async () => {
        ingestCalled += 1;
        return { skipped: false, pineconeUpserted: true, totalChunks: 515 };
      },
    };
    const result = await runBootstrap(config, logger, env, deps);
    const step = result.steps.find(s => s.step === 'guideline_ingest');
    expect(step?.ok).toBe(true);
    expect(step?.skipped).toBeFalsy();
    expect(ingestCalled).toBe(1);
  });

  it('skips guideline ingest when chunk count already matches expected (idempotent)', async () => {
    const env = baseEnv({ AGENTFORGE_GUIDELINES_INGEST: '1', PINECONE_API_KEY: 'pc-test' });
    const config = makeConfig(env);
    const { logger } = makeLogger();
    let ingestCalled = 0;
    const deps: BootstrapDeps = {
      nowImpl: fakeNow,
      currentPineconeChunkCount: async () => 515,
      expectedChunkCount: async () => 515,
      runGuidelineIngest: async () => {
        ingestCalled += 1;
        return { skipped: false, pineconeUpserted: true, totalChunks: 515 };
      },
    };
    const result = await runBootstrap(config, logger, env, deps);
    const step = result.steps.find(s => s.step === 'guideline_ingest');
    expect(step?.ok).toBe(true);
    expect(step?.skipped).toBe(true);
    expect(step?.reason).toContain('idempotent');
    expect(ingestCalled).toBe(0);
  });

  it('captures guideline ingest errors without throwing', async () => {
    const env = baseEnv({ AGENTFORGE_GUIDELINES_INGEST: '1', PINECONE_API_KEY: 'pc-test' });
    const config = makeConfig(env);
    const { logs, logger } = makeLogger();
    const deps: BootstrapDeps = {
      nowImpl: fakeNow,
      currentPineconeChunkCount: async () => 0,
      expectedChunkCount: async () => 515,
      runGuidelineIngest: async () => { throw new Error('pinecone exploded'); },
    };
    const result = await runBootstrap(config, logger, env, deps);
    const step = result.steps.find(s => s.step === 'guideline_ingest');
    expect(step?.ok).toBe(false);
    expect(step?.error).toContain('pinecone exploded');
    expect(logs.some(l => l.level === 'warn')).toBe(true);
  });

  it('runs fixture ingest when gate=1 and demo rows are missing', async () => {
    const env = baseEnv({ AGENTFORGE_FIXTURE_INGEST: '1' });
    const config = makeConfig(env);
    const { logger } = makeLogger();
    let fixtureCalled = 0;
    const deps: BootstrapDeps = {
      nowImpl: fakeNow,
      demoFixturesAlreadyPresent: async () => false,
      runFixtureIngest: async () => { fixtureCalled += 1; return { skipped: false }; },
    };
    const result = await runBootstrap(config, logger, env, deps);
    const step = result.steps.find(s => s.step === 'fixture_ingest');
    expect(step?.ok).toBe(true);
    expect(step?.skipped).toBeFalsy();
    expect(fixtureCalled).toBe(1);
  });

  it('skips fixture ingest when demo rows already present', async () => {
    const env = baseEnv({ AGENTFORGE_FIXTURE_INGEST: '1' });
    const config = makeConfig(env);
    const { logger } = makeLogger();
    let fixtureCalled = 0;
    const deps: BootstrapDeps = {
      nowImpl: fakeNow,
      demoFixturesAlreadyPresent: async () => true,
      runFixtureIngest: async () => { fixtureCalled += 1; return { skipped: false }; },
    };
    const result = await runBootstrap(config, logger, env, deps);
    const step = result.steps.find(s => s.step === 'fixture_ingest');
    expect(step?.skipped).toBe(true);
    expect(step?.reason).toContain('idempotent');
    expect(fixtureCalled).toBe(0);
  });

  it('auto-enables ingest gates when RAILWAY_ENVIRONMENT is non-empty', async () => {
    // Inputs: RAILWAY_ENVIRONMENT set, gates UNSET, no Pinecone key,
    // demo rows missing. Expected: bootstrap treats both gates as 1,
    // guideline step skips (no PINECONE_API_KEY) but the fixture step
    // runs because gates were applied.
    const env = baseEnv({ RAILWAY_ENVIRONMENT: 'production' });
    const config = makeConfig(env);
    const { logs, logger } = makeLogger();
    let fixtureCalled = 0;
    const deps: BootstrapDeps = {
      nowImpl: fakeNow,
      demoFixturesAlreadyPresent: async () => false,
      runFixtureIngest: async () => { fixtureCalled += 1; return { skipped: false }; },
    };
    const result = await runBootstrap(config, logger, env, deps);
    const fixture = result.steps.find(s => s.step === 'fixture_ingest');
    expect(fixture?.ok).toBe(true);
    expect(fixtureCalled).toBe(1);
    // Guideline step skipped because no PINECONE_API_KEY
    const guideline = result.steps.find(s => s.step === 'guideline_ingest');
    expect(guideline?.skipped).toBe(true);
    expect(guideline?.reason).toContain('PINECONE_API_KEY');
    expect(logs.some(l => String(l.msg ?? '').includes('Railway detected'))).toBe(true);
  });

  it('explicit AGENTFORGE_GUIDELINES_INGEST=0 wins over RAILWAY auto-set', async () => {
    const env = baseEnv({
      RAILWAY_ENVIRONMENT: 'production',
      AGENTFORGE_GUIDELINES_INGEST: '0',
      AGENTFORGE_FIXTURE_INGEST: '0',
    });
    const config = makeConfig(env);
    const { logger } = makeLogger();
    const result = await runBootstrap(config, logger, env, { nowImpl: fakeNow });
    const guideline = result.steps.find(s => s.step === 'guideline_ingest');
    expect(guideline?.skipped).toBe(true);
    expect(guideline?.reason).toContain('AGENTFORGE_GUIDELINES_INGEST');
  });

  it('OpenEMR readiness probe gives up after MAX_ATTEMPTS and logs warning, server continues', async () => {
    const env = baseEnv();
    delete env['AGENTFORGE_BOOTSTRAP_SKIP_OPENEMR_PROBE'];
    const config = makeConfig(env);
    const { logs, logger } = makeLogger();
    let attempts = 0;
    const deps: BootstrapDeps = {
      nowImpl: fakeNow,
      sleepImpl: async () => {},
      fetchImpl: (async () => { attempts += 1; throw new Error('connection refused'); }) as unknown as typeof fetch,
    };
    const result = await runBootstrap(config, logger, env, deps);
    const probe = result.steps.find(s => s.step === 'openemr_readiness');
    expect(probe?.ok).toBe(false);
    expect(probe?.attempts).toBe(30);
    expect(attempts).toBe(30);
    expect(logs.some(l => String(l.msg ?? '').includes('did not become ready'))).toBe(true);
    // Other steps still ran — readiness failure does not block.
    expect(result.steps.some(s => s.step === 'guideline_ingest')).toBe(true);
  });

  it('OpenEMR readiness succeeds when probe returns 401 (auth challenge)', async () => {
    const env = baseEnv();
    delete env['AGENTFORGE_BOOTSTRAP_SKIP_OPENEMR_PROBE'];
    const config = makeConfig(env);
    const { logger } = makeLogger();
    const deps: BootstrapDeps = {
      nowImpl: fakeNow,
      sleepImpl: async () => {},
      fetchImpl: (async () => ({ ok: false, status: 401 })) as unknown as typeof fetch,
    };
    const result = await runBootstrap(config, logger, env, deps);
    const probe = result.steps.find(s => s.step === 'openemr_readiness');
    expect(probe?.ok).toBe(true);
    expect(probe?.attempts).toBe(1);
  });
});
