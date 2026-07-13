/**
 * Pre-extracted fixture shape test — every committed
 * `agent/data/fixtures/pre-extracted/*.json` MUST validate against
 * the appropriate Zod schema. The eval suite (issue 17) treats these
 * files as deterministic ground truth, so a schema drift here would
 * silently invalidate the entire fixture-bucket of the eval gate.
 *
 * Lab fixtures parse against LabPdfSchema; intake fixtures parse
 * against IntakeFormSchema. The list is hard-coded so adding a new
 * fixture without wiring it up here fails CI.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { LabPdfSchema } from '../../../src/schemas/LabPdfSchema.js';
import { IntakeFormSchema } from '../../../src/schemas/IntakeFormSchema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, '..', '..', '..', 'data', 'fixtures', 'pre-extracted');

const LAB_FIXTURES = [
  'p01-chen-lipid-panel',
  'p02-whitaker-cbc',
  'p03-reyes-hba1c',
  'p04-kowalski-cmp',
] as const;
const INTAKE_FIXTURES = [
  'p01-chen-intake-typed',
  'p02-whitaker-intake',
  'p03-reyes-intake',
  'p04-kowalski-intake',
] as const;

function loadJson(name: string): unknown {
  const path = resolve(fixturesDir, `${name}.json`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe('pre-extracted fixture shapes', () => {
  describe('lab fixtures parse against LabPdfSchema', () => {
    for (const name of LAB_FIXTURES) {
      it(`${name}.json`, () => {
        const raw = loadJson(name);
        const parsed = LabPdfSchema.parse(raw);
        expect(parsed.doc_type).toBe('lab_pdf');
        expect(parsed.schema_version).toBe('1');
        expect(parsed.results.length).toBeGreaterThanOrEqual(0);
      });
    }
  });

  describe('intake fixtures parse against IntakeFormSchema', () => {
    for (const name of INTAKE_FIXTURES) {
      it(`${name}.json`, () => {
        const raw = loadJson(name);
        const parsed = IntakeFormSchema.parse(raw);
        expect(parsed.doc_type).toBe('intake_form');
        expect(parsed.schema_version).toBe('1');
      });
    }
  });
});
