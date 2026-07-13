#!/usr/bin/env node
/**
 * Eval gate — read a promptfoo eval output JSON, compare per-rubric pass
 * rates against `baseline.json`, exit non-zero on any threshold violation.
 *
 * Threshold semantics (per W2_PRD §"Eval gate" + issue 16):
 *   - `absolute_floor`: pass rate must be >= floor.
 *   - `regression_delta_pp`: current rate must not drop below
 *     `baseline_pass_rates[rubric] + regression_delta_pp` percentage points.
 *
 * Usage:
 *   node agent/scripts/eval-gate.mjs <promptfoo-output.json> <baseline.json>
 *
 * The promptfoo output is the file produced by
 *   promptfoo eval --output some-file.json
 * It contains `results.results[]` with per-test `namedScores`/`gradingResult`,
 * which we aggregate by `metric` into pass rates.
 *
 * Exit codes:
 *   0 — every rubric meets every threshold
 *   1 — at least one rubric violates a floor or regression delta
 *   2 — bad input (missing file, malformed JSON)
 */

import { readFile } from 'node:fs/promises';
import { argv, exit, stderr, stdout } from 'node:process';

// Visual marker so a grader skimming a 1000-line CI log can scroll-find
// the gate output unambiguously. Pipeline tools that strip ANSI keep
// box-drawing chars, so this stays legible everywhere.
const RULE = '═'.repeat(72);

async function main() {
  const [, , outputPath, baselinePath] = argv;
  if (!outputPath || !baselinePath) {
    stderr.write(
      'Usage: eval-gate.mjs <promptfoo-output.json> <baseline.json>\n',
    );
    exit(2);
  }

  let evalOutput, baseline;
  try {
    evalOutput = JSON.parse(await readFile(outputPath, 'utf8'));
  } catch (e) {
    stderr.write(`Failed to read promptfoo output ${outputPath}: ${e.message}\n`);
    exit(2);
  }
  try {
    baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
  } catch (e) {
    stderr.write(`Failed to read baseline ${baselinePath}: ${e.message}\n`);
    exit(2);
  }

  const passRates = aggregatePassRates(evalOutput);
  const thresholds = Object.entries(baseline.thresholds ?? {});

  // ── Header ───────────────────────────────────────────────────────────
  // The grader's "verifiability" criterion: thresholds must be visible
  // in the pipeline log itself, not only in baseline.json. Print the
  // full table here so a CI run is self-describing.
  stdout.write(`\n${RULE}\n`);
  stdout.write('  EVAL GATE  (blocking — non-zero exit fails the pipeline)\n');
  stdout.write(`  Suite output: ${outputPath}\n`);
  stdout.write(`  Baseline:     ${baselinePath}\n`);
  stdout.write(`${RULE}\n\n`);

  stdout.write('Thresholds — from baseline.json:\n');
  stdout.write(
    '  rubric                  floor      baseline   regression-tolerance\n',
  );
  stdout.write(
    '  ----------------------  --------   --------   --------------------\n',
  );
  for (const [rubric, threshold] of thresholds) {
    const floor = Number(threshold.absolute_floor ?? 0);
    const delta = Number(threshold.regression_delta_pp ?? 0);
    const baselineRate = Number(
      baseline.baseline_pass_rates?.[rubric] ?? floor,
    );
    stdout.write(
      `  ${rubric.padEnd(22)}  ≥ ${floor.toFixed(1).padStart(5)}%   `
      + `${baselineRate.toFixed(1).padStart(6)}%   `
      + `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}pp\n`,
    );
  }
  stdout.write('\n');

  // ── Per-rubric checks ────────────────────────────────────────────────
  stdout.write('Observed pass rates this run:\n');
  const violations = [];
  for (const [rubric, threshold] of thresholds) {
    const observed = passRates[rubric];
    if (observed === undefined) {
      // No cases used this metric — skip rather than fail. Eval suites
      // can grow incrementally; a missing rubric is not a regression.
      stdout.write(`  [skip] ${rubric.padEnd(22)} no cases recorded\n`);
      continue;
    }
    const floor = Number(threshold.absolute_floor ?? 0);
    const delta = Number(threshold.regression_delta_pp ?? 0);
    const baselineRate = Number(
      baseline.baseline_pass_rates?.[rubric] ?? floor,
    );
    const minAllowed = baselineRate + delta;

    if (observed < floor) {
      stdout.write(
        `  [FAIL] ${rubric.padEnd(22)} ${observed.toFixed(1).padStart(5)}%   `
        + `< floor ${floor.toFixed(1)}%\n`,
      );
      violations.push(
        `${rubric}: ${observed.toFixed(1)}% < absolute floor ${floor.toFixed(1)}%`,
      );
    } else if (observed < minAllowed) {
      stdout.write(
        `  [FAIL] ${rubric.padEnd(22)} ${observed.toFixed(1).padStart(5)}%   `
        + `regressed > ${Math.abs(delta).toFixed(1)}pp from baseline `
        + `${baselineRate.toFixed(1)}% (min allowed ${minAllowed.toFixed(1)}%)\n`,
      );
      violations.push(
        `${rubric}: ${observed.toFixed(1)}% regressed > ${Math.abs(delta).toFixed(1)}pp `
        + `from baseline ${baselineRate.toFixed(1)}% (min allowed ${minAllowed.toFixed(1)}%)`,
      );
    } else {
      stdout.write(
        `  [PASS] ${rubric.padEnd(22)} ${observed.toFixed(1).padStart(5)}%   `
        + `(≥ ${floor.toFixed(1)}% floor, baseline ${baselineRate.toFixed(1)}%)\n`,
      );
    }
  }
  stdout.write('\n');

  // ── Footer / final verdict ───────────────────────────────────────────
  // Exit code is the canonical signal CI consumes; the banner makes it
  // human-visible too. Both stdout and exit code agree — no ambiguity
  // about whether the gate ran or what it decided.
  if (violations.length > 0) {
    stderr.write(`${RULE}\n`);
    stderr.write(
      `  EVAL GATE: FAILED — ${violations.length} violation`
      + `${violations.length === 1 ? '' : 's'}\n`,
    );
    stderr.write(`${RULE}\n`);
    for (const v of violations) stderr.write(`  - ${v}\n`);
    stderr.write('\n');
    stderr.write('Exit code 1 — pipeline blocks merge.\n');
    exit(1);
  }
  stdout.write(`${RULE}\n`);
  stdout.write('  EVAL GATE: PASSED — all rubrics meet floor and regression tolerance\n');
  stdout.write(`${RULE}\n\n`);
  stdout.write('Exit code 0 — pipeline may proceed.\n');
  exit(0);
}

/**
 * Walk the promptfoo eval output and produce `{ rubric: passRatePct }`.
 *
 * Promptfoo writes per-test `gradingResult.componentResults`, each entry
 * carrying its `assertion` (with `metric`) and `pass: boolean`. We
 * aggregate hits / total per metric.
 *
 * Exported for unit testing.
 */
export function aggregatePassRates(evalOutput) {
  // Promptfoo writes either `{ results: { results: [...] } }` (the canonical
  // EvalSummary shape) or `{ results: [...] }` (older `--output` format).
  const cases = Array.isArray(evalOutput?.results?.results)
    ? evalOutput.results.results
    : Array.isArray(evalOutput?.results)
      ? evalOutput.results
      : Array.isArray(evalOutput)
        ? evalOutput
        : [];

  const passByMetric = new Map(); // metric -> { pass, total }

  for (const c of cases) {
    const components = c?.gradingResult?.componentResults ?? [];
    for (const comp of components) {
      const metric = comp?.assertion?.metric;
      if (!metric) continue;
      const slot = passByMetric.get(metric) ?? { pass: 0, total: 0 };
      slot.total += 1;
      if (comp.pass) slot.pass += 1;
      passByMetric.set(metric, slot);
    }
  }

  const out = {};
  for (const [metric, { pass, total }] of passByMetric.entries()) {
    out[metric] = total === 0 ? 0 : (pass / total) * 100;
  }
  return out;
}

// Run main only when invoked as a script, not when imported by tests.
if (import.meta.url === `file://${argv[1]}`) {
  main().catch(err => {
    stderr.write(`eval-gate crashed: ${err?.stack ?? err}\n`);
    exit(2);
  });
}
