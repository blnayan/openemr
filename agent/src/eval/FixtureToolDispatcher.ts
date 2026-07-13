/**
 * FixtureToolDispatcher — eval-only fixture-backed override for the
 * chart tool registry.
 *
 * The promptfoo eval suite under `agent/evals/tests/` POSTs to a running
 * agent service on `:3030`. Without this dispatcher every chart-tool
 * call (`get_medications`, `get_recent_labs`, …) falls through to the
 * production FhirClient → real OpenEMR FHIR endpoint → real MariaDB,
 * which makes evals non-deterministic and DB-state-dependent. Per the
 * test-isolation principle, evals should run against a frozen fixture,
 * not whatever the dev DB happens to look like today.
 *
 * Mechanism: when `AGENTFORGE_EVAL_FIXTURE_PATH` is set at agent
 * startup, this module mutates `TOOL_REGISTRY` in place so each tool
 * returns its fixture's `ToolResult` instead of calling FhirClient.
 * Same pattern as `withFixture` in `tests/pipeline/runPrevisit.test.ts`,
 * just at process startup with no restore (fixture mode is the whole
 * run).
 *
 * Safety:
 *   - The env var is opt-in. With it unset, zero behavior change.
 *   - When the var IS set, the agent emits a loud `console.warn` on
 *     every startup so production environments cannot silently fall
 *     into fixture mode.
 *   - The check_drug_interactions tool is intentionally NOT overridden:
 *     it's a deterministic local table lookup with no DB dependency,
 *     so evals SHOULD exercise the real implementation.
 *
 * Fixture shape (machine-readable JSON):
 *   {
 *     "patient_uuid": "<uuid>",        // optional — for runbook/debug only
 *     "description":  "<freeform>",    // optional
 *     "tools": {
 *       "get_patient_summary":  { ok: true, tool: "get_patient_summary",  rows: [...] },
 *       "get_active_problems":  { ok: true, tool: "get_active_problems",  rows: [...] },
 *       "get_medications":      { ok: true, tool: "get_medications",      rows: [...] },
 *       "get_recent_labs":      { ok: true, tool: "get_recent_labs",      rows: [...] },
 *       "get_vitals":           { ok: true, tool: "get_vitals",           rows: [...] },
 *       "get_allergies":        { ok: true, tool: "get_allergies",        rows: [...] },
 *       "get_recent_encounters":{ ok: true, tool: "get_recent_encounters",rows: [...] }
 *     }
 *   }
 *
 * Every entry is a literal `ToolResult` — the same shape pipeline
 * fixtures use. The `tool` field on each result must match the key
 * (validated at load time so a typo doesn't silently shadow the wrong
 * tool).
 */

import { readFileSync } from 'node:fs';
import { TOOL_REGISTRY } from '../tools/index.js';
import type { ToolFunction, ToolResult } from '../tools/types.js';

/** Env var name. Unset → no-op. */
export const FIXTURE_PATH_ENV = 'AGENTFORGE_EVAL_FIXTURE_PATH';

/** Tools whose chart-data lookups go through FhirClient and should be fixture-backed. */
const FIXTURE_BACKED_TOOLS = [
  'get_patient_summary',
  'get_active_problems',
  'get_medications',
  'get_recent_labs',
  'get_vitals',
  'get_allergies',
  'get_recent_encounters',
] as const;

type FixtureBackedTool = (typeof FIXTURE_BACKED_TOOLS)[number];

interface FixturePayload {
  patient_uuid?: string;
  description?: string;
  tools: Partial<Record<FixtureBackedTool, ToolResult>>;
}

/**
 * Apply the fixture pointed at by `AGENTFORGE_EVAL_FIXTURE_PATH` if set.
 * Returns:
 *   - `{ active: false }` when the env var is unset (the production path).
 *   - `{ active: true, ... }` when the override was applied. The bootstrap
 *     uses this to log a single loud warning at startup.
 *
 * Throws if the env var is set but the file is missing, malformed, or
 * fails the per-tool sanity checks. Better to crash at boot than to
 * silently run with a half-applied override.
 */
export function applyEvalFixturesFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  warn: (msg: string, ctx?: Record<string, unknown>) => void = (m, c) => console.warn(`[agentforge] ${m}`, c ?? {}),
): { active: false } | { active: true; path: string; toolsOverridden: string[]; patientUuid?: string } {
  const path = env[FIXTURE_PATH_ENV];
  if (!path) {
    return { active: false };
  }

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(
      `${FIXTURE_PATH_ENV}=${path} but the file could not be read: `
      + (err instanceof Error ? err.message : String(err)),
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${FIXTURE_PATH_ENV}=${path} contains invalid JSON: `
      + (err instanceof Error ? err.message : String(err)),
    );
  }

  const fixture = validateFixture(parsed, path);
  const overridden = applyFixtureToRegistry(fixture);

  warn(
    'EVAL FIXTURE MODE ACTIVE — chart tools are returning fixture data, not live FHIR. '
    + 'Unset AGENTFORGE_EVAL_FIXTURE_PATH to restore production behavior.',
    {
      fixture_path: path,
      tools_overridden: overridden,
      patient_uuid: fixture.patient_uuid ?? '<unset>',
      description: fixture.description ?? '<unset>',
    },
  );

  return {
    active: true,
    path,
    toolsOverridden: overridden,
    ...(fixture.patient_uuid !== undefined ? { patientUuid: fixture.patient_uuid } : {}),
  };
}

/**
 * Read-then-write replacement of TOOL_REGISTRY entries with fixture-backed
 * functions. Returns the list of tools that actually got overridden so the
 * caller can log it.
 *
 * Tools missing from the fixture's `tools` map are left alone — they call
 * FhirClient as usual. That's a deliberate choice: a partial fixture
 * (e.g. only labs and vitals defined) is a useful debug shape, and we
 * want failures to surface as "no fixture for X" rather than "tool
 * silently returned ok:false".
 */
function applyFixtureToRegistry(fixture: FixturePayload): string[] {
  const overridden: string[] = [];
  for (const tool of FIXTURE_BACKED_TOOLS) {
    const result = fixture.tools[tool];
    if (result === undefined) continue;
    const fn: ToolFunction = async () => result;
    (TOOL_REGISTRY as Record<string, ToolFunction>)[tool] = fn;
    overridden.push(tool);
  }
  return overridden;
}

/**
 * Validate the parsed JSON against the FixturePayload shape. We hand-roll
 * this rather than reach for Zod because the agent already loads enough
 * Zod schemas at startup; one more for an eval-only path isn't worth the
 * cycle, and the shape is small enough that a flat checker is clearer.
 */
function validateFixture(value: unknown, sourcePath: string): FixturePayload {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`fixture at ${sourcePath}: expected a JSON object at the top level`);
  }
  const obj = value as Record<string, unknown>;

  if (!('tools' in obj) || obj['tools'] === null || typeof obj['tools'] !== 'object' || Array.isArray(obj['tools'])) {
    throw new Error(`fixture at ${sourcePath}: top-level "tools" must be an object`);
  }
  const toolsRaw = obj['tools'] as Record<string, unknown>;
  const tools: Partial<Record<FixtureBackedTool, ToolResult>> = {};

  for (const [toolName, raw] of Object.entries(toolsRaw)) {
    if (!FIXTURE_BACKED_TOOLS.includes(toolName as FixtureBackedTool)) {
      throw new Error(
        `fixture at ${sourcePath}: tools.${toolName} is not a fixture-backed tool. `
        + `Allowed: ${FIXTURE_BACKED_TOOLS.join(', ')}`,
      );
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`fixture at ${sourcePath}: tools.${toolName} must be a ToolResult object`);
    }
    const r = raw as Record<string, unknown>;
    if (!('ok' in r) || typeof r['ok'] !== 'boolean') {
      throw new Error(`fixture at ${sourcePath}: tools.${toolName}.ok must be a boolean`);
    }
    if (typeof r['tool'] !== 'string' || r['tool'] !== toolName) {
      throw new Error(
        `fixture at ${sourcePath}: tools.${toolName}.tool must equal ${JSON.stringify(toolName)} `
        + `(got ${JSON.stringify(r['tool'] ?? null)})`,
      );
    }
    if (r['ok'] === true) {
      if (!Array.isArray(r['rows'])) {
        throw new Error(`fixture at ${sourcePath}: tools.${toolName}.rows must be an array when ok=true`);
      }
    } else {
      if (typeof r['reason'] !== 'string') {
        throw new Error(`fixture at ${sourcePath}: tools.${toolName}.reason must be a string when ok=false`);
      }
    }
    tools[toolName as FixtureBackedTool] = r as unknown as ToolResult;
  }

  const out: FixturePayload = { tools };
  if (typeof obj['patient_uuid'] === 'string') {
    out.patient_uuid = obj['patient_uuid'];
  }
  if (typeof obj['description'] === 'string') {
    out.description = obj['description'];
  }
  return out;
}

// Test-only helper: re-export the constant so callers (and tests) don't
// have to hard-code the string.
export const __FIXTURE_BACKED_TOOLS = FIXTURE_BACKED_TOOLS;
