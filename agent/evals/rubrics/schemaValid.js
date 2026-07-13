/**
 * schemaValid — deterministic schema-validation rubric.
 *
 * Parses the captured response payload through the relevant Zod schema
 * and returns pass/fail. The rubric picks the schema by sniffing the
 * payload — any object with `doc_type === 'lab_pdf'` goes through
 * `LabPdfSchema`; `doc_type === 'intake_form'` through
 * `IntakeFormSchema`; everything else through `AnswerSchema`.
 *
 * No LLM judge. Pure schema-driven.
 *
 * Returns `{ pass, score, reason }` per the rubric contract documented
 * in issues/16-eval-framework-and-non-fixture-cases.md.
 */

import { AnswerSchema } from '../../src/schemas/AnswerSchema.js';
import { LabPdfSchema } from '../../src/schemas/LabPdfSchema.js';
import { IntakeFormSchema } from '../../src/schemas/IntakeFormSchema.js';
import { extractAnswer, pass, fail } from './_helpers.js';

export default async function schemaValid(output, _context) {
  // Disambiguate extraction outputs first — promptfoo can pass them
  // either as a parsed object or a JSON-encoded string.
  const candidate = pickExtractionPayload(output);
  if (candidate) {
    if (candidate.doc_type === 'lab_pdf') {
      const r = LabPdfSchema.safeParse(candidate);
      return r.success ? pass('LabPdfSchema validated') : fail(`LabPdfSchema invalid: ${describeIssues(r.error)}`);
    }
    if (candidate.doc_type === 'intake_form') {
      const r = IntakeFormSchema.safeParse(candidate);
      return r.success ? pass('IntakeFormSchema validated') : fail(`IntakeFormSchema invalid: ${describeIssues(r.error)}`);
    }
  }

  // Default: chat answer.
  const answer = extractAnswer(output);
  if (!answer) {
    return fail('no Answer-shaped payload could be extracted from output');
  }
  const result = AnswerSchema.safeParse(answer);
  if (!result.success) {
    return fail(`AnswerSchema invalid: ${describeIssues(result.error)}`);
  }
  return pass('AnswerSchema validated');
}

function pickExtractionPayload(output) {
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    if (output.doc_type === 'lab_pdf' || output.doc_type === 'intake_form') return output;
  }
  if (typeof output === 'string') {
    const trimmed = output.trim();
    if (!trimmed.startsWith('{')) return null;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && (parsed.doc_type === 'lab_pdf' || parsed.doc_type === 'intake_form')) return parsed;
    } catch { /* not JSON */ }
  }
  return null;
}

function describeIssues(error) {
  if (!error?.issues) return error?.message ?? String(error);
  return error.issues
    .slice(0, 5)
    .map(i => `${i.path.join('.') || '<root>'}: ${i.message}`)
    .join('; ');
}
