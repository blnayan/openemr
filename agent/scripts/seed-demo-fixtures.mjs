#!/usr/bin/env node
/**
 * One-shot AgentForge demo-fixture ingest script.
 *
 *   1. Runs `contrib/agentforge/seed_demo_pdf_patients.php` to ensure
 *      the four demo patients exist (idempotent).
 *   2. Walks `agent/data/fixtures/intake-forms/` and
 *      `agent/data/fixtures/lab-results/` directories. For each file
 *      whose name matches `p{NN}-{anything}.{pdf|png}`, shells out to
 *      `contrib/agentforge/ingest_demo_fixture.php` to drive the new
 *      Document Inbox `UploadController` end-to-end: the source bytes
 *      land in the canonical `documents` table, extraction runs against
 *      the agent service, and the result is auto-confirmed via
 *      `ConfirmCommitter` with the synthetic system reviewer (admin) so
 *      a fresh deploy boots into `committed` rows visible in the inbox.
 *
 * The PHP ingestor is idempotent — a fixture whose extraction row
 * already exists is reported as `skipped_exists` and re-running this
 * script is a safe no-op.
 *
 * Filename convention:
 *   intake-forms/p01-chen-intake-typed.pdf  → patient AGENTFORGE-DEMO-PDF-001, doc_type=intake_form
 *   lab-results/p04-kowalski-cmp.pdf        → patient AGENTFORGE-DEMO-PDF-004, doc_type=lab_pdf
 *
 * Usage (requires the OpenEMR Docker stack — the PHP CLI must be
 * able to bootstrap interface/globals.php):
 *   node agent/scripts/seed-demo-fixtures.mjs
 *   node agent/scripts/seed-demo-fixtures.mjs --seed-only
 *
 * Inside the Railway / Docker container the script is normally run
 * by the Node bootstrap (`fixture_ingest` step) when
 * `AGENTFORGE_FIXTURE_INGEST=1`. Running it from the host requires
 * `php` resolving to the container's PHP — call it via
 * `docker compose exec openemr node /var/www/.../seed-demo-fixtures.mjs`.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, extname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');
const fixturesDir = resolve(__dirname, '..', 'data', 'fixtures');
const intakeDir = resolve(fixturesDir, 'intake-forms');
const labDir = resolve(fixturesDir, 'lab-results');

const SEED_PATIENTS_SCRIPT = resolve(repoRoot, 'contrib', 'agentforge', 'seed_demo_pdf_patients.php');
const INGEST_SCRIPT = resolve(repoRoot, 'contrib', 'agentforge', 'ingest_demo_fixture.php');

const PATIENT_NUMBER_PATTERN = /^p(\d{2})-/i;
const SUPPORTED_EXTS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.webp']);

const seedOnly = process.argv.includes('--seed-only');

function runPhpSeeder() {
  if (!existsSync(SEED_PATIENTS_SCRIPT)) {
    throw new Error(`PHP seeder not found at ${SEED_PATIENTS_SCRIPT}`);
  }
  console.error(`[seed-demo-fixtures] running php seeder: ${SEED_PATIENTS_SCRIPT}`);
  let stdout;
  try {
    stdout = execFileSync('php', [SEED_PATIENTS_SCRIPT], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    });
  } catch {
    console.error('[seed-demo-fixtures] PHP seeder failed (likely no DB access from host).');
    console.error('[seed-demo-fixtures] Run inside the docker dev stack:');
    console.error('  docker compose exec openemr php contrib/agentforge/seed_demo_pdf_patients.php');
    return null;
  }
  return JSON.parse(stdout);
}

/**
 * Walk a directory, filter to fixture-shaped filenames, and emit
 * { pubpid, file, docType } tuples ready to feed to the PHP ingestor.
 */
function walkFixtures(dir, docType) {
  if (!existsSync(dir)) {
    console.error(`[seed-demo-fixtures] fixtures dir not found: ${dir}`);
    return [];
  }
  const tuples = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const ext = extname(entry.name).toLowerCase();
    if (!SUPPORTED_EXTS.has(ext)) continue;
    const match = PATIENT_NUMBER_PATTERN.exec(entry.name);
    if (!match) {
      console.error(`[seed-demo-fixtures] skipping non-conforming filename: ${entry.name}`);
      continue;
    }
    // Filenames use 2-digit patient numbers (`p01`..`p04`); pubpids use
    // 3-digit (`AGENTFORGE-DEMO-PDF-001`..`004`). Pad here.
    const padded = match[1].padStart(3, '0');
    const pubpid = `AGENTFORGE-DEMO-PDF-${padded}`;
    tuples.push({
      pubpid,
      docType,
      file: resolve(dir, entry.name),
      basename: entry.name,
    });
  }
  // Stable order so demo runs are deterministic.
  tuples.sort((a, b) => a.basename.localeCompare(b.basename));
  return tuples;
}

function ingestFixture({ pubpid, docType, file }) {
  const out = execFileSync('php', [
    INGEST_SCRIPT,
    `--pubpid=${pubpid}`,
    `--doc-type=${docType}`,
    `--file=${file}`,
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return JSON.parse(out.trim());
}

function main() {
  const seeded = runPhpSeeder();
  if (!seeded) {
    console.error('[seed-demo-fixtures] seed step skipped — committed pre-extracted JSONs remain authoritative.');
    return;
  }
  if (Array.isArray(seeded)) {
    for (const p of seeded) {
      console.error(`[seed-demo-fixtures] patient ${p.pubpid} pid=${p.pid} (${p.status})`);
    }
  }

  if (seedOnly) {
    console.error('[seed-demo-fixtures] --seed-only: stopping after patient seed.');
    return;
  }

  const intakeFixtures = walkFixtures(intakeDir, 'intake_form');
  const labFixtures = walkFixtures(labDir, 'lab_pdf');
  const allFixtures = [...intakeFixtures, ...labFixtures];

  if (allFixtures.length === 0) {
    console.error('[seed-demo-fixtures] no fixtures matched p{NN}-* under intake-forms/ or lab-results/');
    return;
  }

  let uploaded = 0;
  let skipped = 0;
  let failed = 0;

  for (const fixture of allFixtures) {
    try {
      const result = ingestFixture(fixture);
      if (result.status === 'uploaded') {
        uploaded += 1;
      } else if (result.status === 'skipped_exists') {
        skipped += 1;
      }
      console.error(
        `[seed-demo-fixtures] ${fixture.basename} → pid=${result.pid} document_id=${result.document_id} (${result.status})`
      );
    } catch (err) {
      failed += 1;
      console.error(`[seed-demo-fixtures] FAILED ${fixture.basename}: ${err.message}`);
    }
  }

  console.error(
    `[seed-demo-fixtures] done — uploaded=${uploaded} skipped=${skipped} failed=${failed} total=${allFixtures.length}`
  );

  if (failed > 0) {
    process.exit(1);
  }
}

main();
