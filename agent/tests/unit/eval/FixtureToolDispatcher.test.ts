/**
 * FixtureToolDispatcher unit tests.
 *
 * Locks in the contract callers depend on:
 *   - env unset → no-op (production path)
 *   - env set → mutates TOOL_REGISTRY in place; returns the override summary
 *   - missing file / bad JSON / bad shape → throws at boot (no silent
 *     half-applied state)
 *   - check_drug_interactions stays untouched (deterministic local lookup)
 *   - the active warning is fired exactly once per call
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FIXTURE_PATH_ENV,
  applyEvalFixturesFromEnv,
} from '../../../src/eval/FixtureToolDispatcher.js';
import { TOOL_REGISTRY } from '../../../src/tools/index.js';

let tmpDir: string;
const originalRegistry = new Map<string, typeof TOOL_REGISTRY[string]>();

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'fixture-disp-'));
  // Snapshot original tool implementations so each test can restore.
  for (const [name, fn] of Object.entries(TOOL_REGISTRY)) {
    originalRegistry.set(name, fn);
  }
});

afterEach(() => {
  // Restore TOOL_REGISTRY for subsequent tests in the same vitest worker.
  for (const [name, fn] of originalRegistry) {
    (TOOL_REGISTRY as Record<string, unknown>)[name] = fn;
  }
  originalRegistry.clear();
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeFixture(payload: unknown): string {
  const path = join(tmpDir, 'fixture.json');
  writeFileSync(path, JSON.stringify(payload));
  return path;
}

describe('applyEvalFixturesFromEnv', () => {
  it('is a no-op when AGENTFORGE_EVAL_FIXTURE_PATH is unset', () => {
    const warn = vi.fn();
    const result = applyEvalFixturesFromEnv({}, warn);

    expect(result).toEqual({ active: false });
    expect(warn).not.toHaveBeenCalled();
    // Each tool is still its production identity.
    for (const [name, fn] of originalRegistry) {
      expect(TOOL_REGISTRY[name]).toBe(fn);
    }
  });

  it('overrides only the tools the fixture defines and warns loudly', async () => {
    const path = writeFixture({
      patient_uuid: 'fix-uuid-001',
      description: 'eval-suite seed',
      tools: {
        get_medications: {
          ok: true,
          tool: 'get_medications',
          rows: [{ id: 'tool:get_medications:row-0', name: 'Lisinopril 10 MG', rxnorm: '314076' }],
        },
        get_allergies: {
          ok: true,
          tool: 'get_allergies',
          rows: [],
        },
      },
    });
    const warn = vi.fn();
    const result = applyEvalFixturesFromEnv({ [FIXTURE_PATH_ENV]: path }, warn);

    expect(result).toEqual(expect.objectContaining({
      active: true,
      path,
      patientUuid: 'fix-uuid-001',
    }));
    expect((result as { toolsOverridden: string[] }).toolsOverridden.sort()).toEqual(['get_allergies', 'get_medications']);

    // Loud warning fires exactly once.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/EVAL FIXTURE MODE ACTIVE/);

    // Overridden tools return fixture data.
    const meds = await TOOL_REGISTRY['get_medications']!({}, {} as never);
    expect(meds).toMatchObject({ ok: true, tool: 'get_medications', rows: [expect.objectContaining({ name: 'Lisinopril 10 MG' })] });
    const allergies = await TOOL_REGISTRY['get_allergies']!({}, {} as never);
    expect(allergies).toMatchObject({ ok: true, tool: 'get_allergies', rows: [] });

    // NON-overridden tools still point at their original implementation.
    expect(TOOL_REGISTRY['get_recent_labs']).toBe(originalRegistry.get('get_recent_labs'));
    expect(TOOL_REGISTRY['get_vitals']).toBe(originalRegistry.get('get_vitals'));
  });

  it('does NOT override check_drug_interactions even if listed in the fixture', () => {
    // check_drug_interactions is not in the fixture-backed allowlist.
    // A fixture that tries to override it MUST fail validation rather
    // than silently skip — otherwise a fixture author thinks they
    // overrode it and the agent falls through to the real impl.
    const path = writeFixture({
      tools: {
        check_drug_interactions: { ok: true, tool: 'check_drug_interactions', rows: [] },
      },
    });

    expect(() => applyEvalFixturesFromEnv({ [FIXTURE_PATH_ENV]: path }, () => {}))
      .toThrow(/check_drug_interactions is not a fixture-backed tool/);
    // No partial override happened.
    expect(TOOL_REGISTRY['check_drug_interactions']).toBe(originalRegistry.get('check_drug_interactions'));
  });

  it('throws when the fixture file is missing', () => {
    expect(() => applyEvalFixturesFromEnv({ [FIXTURE_PATH_ENV]: '/no/such/path.json' }, () => {}))
      .toThrow(/could not be read/);
  });

  it('throws on malformed JSON', () => {
    const path = join(tmpDir, 'bad.json');
    writeFileSync(path, '{ this is not json');
    expect(() => applyEvalFixturesFromEnv({ [FIXTURE_PATH_ENV]: path }, () => {}))
      .toThrow(/invalid JSON/);
  });

  it('throws when tools.<name>.tool key does not match its outer key', () => {
    const path = writeFixture({
      tools: {
        get_medications: { ok: true, tool: 'get_recent_labs', rows: [] }, // mismatch
      },
    });
    expect(() => applyEvalFixturesFromEnv({ [FIXTURE_PATH_ENV]: path }, () => {}))
      .toThrow(/tool must equal "get_medications"/);
  });

  it('throws when an ok=true result has no rows array', () => {
    const path = writeFixture({
      tools: {
        get_medications: { ok: true, tool: 'get_medications' /* missing rows */ },
      },
    });
    expect(() => applyEvalFixturesFromEnv({ [FIXTURE_PATH_ENV]: path }, () => {}))
      .toThrow(/rows must be an array/);
  });

  it('accepts ok=false fixtures (degraded chart scenarios)', async () => {
    const path = writeFixture({
      tools: {
        get_recent_labs: { ok: false, tool: 'get_recent_labs', reason: 'fhir_unreachable' },
      },
    });
    applyEvalFixturesFromEnv({ [FIXTURE_PATH_ENV]: path }, () => {});

    const labs = await TOOL_REGISTRY['get_recent_labs']!({}, {} as never);
    expect(labs).toEqual({ ok: false, tool: 'get_recent_labs', reason: 'fhir_unreachable' });
  });
});
