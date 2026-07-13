/**
 * clinicalNumericsBolded — deterministic check that concrete clinical
 * values in an answer's `summary` are wrapped in markdown bold
 * (`**...**`).
 *
 * Issue #34 instructs the synthesizer prompt to wrap HbA1c percentages,
 * LDL/HDL/cholesterol numbers, blood pressure readings, and medication
 * doses in `**...**` so the SPA's <strong>-renderer can highlight them
 * for the doctor's eye. Without an offline rubric, an off-spec model
 * could silently drop the bolds and the regression would only surface
 * by visual inspection.
 *
 * Heuristic:
 *   1. Detect whether the summary plausibly contains a clinical numeric
 *      via a forgiving regex (HbA1c %, LDL/HDL/total-cholesterol mg/dL,
 *      BP NN/NN, medication doses ending in mg/mcg/g/units).
 *   2. If no numeric is detected, the rubric vacuously passes — the
 *      answer simply didn't have a value to bold.
 *   3. If a numeric IS detected, require at least ONE markdown-bold run
 *      that itself contains a digit. We do NOT demand that every numeric
 *      is bolded — the model is allowed to pick the most clinically
 *      salient one, and a partial match is still better than none.
 *
 * The rubric never inspects claims[*].text — claims render separately
 * and the prompt explicitly forbids bolding inside them.
 *
 * No LLM judge. Pure regex.
 */

import { extractAnswer, pass, fail } from './_helpers.js';

/**
 * Patterns that suggest the summary is talking about a clinical numeric
 * value. These are intentionally forgiving: false positives just push
 * the rubric harder; false negatives let off-spec output slip through.
 */
const NUMERIC_PATTERNS = [
  // HbA1c / A1c percentages: "A1c 7.4%", "HbA1c is 8%", "A1c of 7.0%"
  /\b(?:hb)?a1c\b[^\n]{0,30}?\d+(?:\.\d+)?\s*%/i,
  // LDL / HDL / total cholesterol with mg/dL or bare integer in context
  /\b(?:ldl|hdl|cholesterol|triglycerides?)\b[^\n]{0,30}?\d+(?:\.\d+)?\s*(?:mg\/?dl)?/i,
  // Blood pressure systolic/diastolic
  /\b(?:bp|blood pressure|systolic|diastolic)\b[^\n]{0,30}?\d{2,3}\s*\/\s*\d{2,3}/i,
  // Bare BP reading without a label, e.g. "138/86 in clinic"
  /\b\d{2,3}\s*\/\s*\d{2,3}\b\s*(?:mmhg|in\s+clinic)?/i,
  // Medication doses: "metformin 1000 mg", "lisinopril 20 mg daily", "5 mg"
  /\d+(?:\.\d+)?\s*(?:mg|mcg|µg|ug|g|units|iu)\b/i,
  // eGFR
  /\begfr\b[^\n]{0,30}?\d+(?:\.\d+)?/i,
];

/**
 * Match a markdown bold run that contains at least one digit. We don't
 * try to parse markdown structurally — we just require the literal
 * `**...**` pair around digits somewhere in the summary.
 *
 * Notes on the regex:
 *   - `\*\*` opens / closes the run.
 *   - `(?:[^*]|\*(?!\*))+?` is "one or more chars that are not `*`,
 *     OR a single `*` not followed by another `*`" (so we don't choke
 *     on e.g. literal `*` inside the bold run).
 *   - The lazy `+?` keeps the match minimal — pairs the FIRST closing
 *     `**` with the opening one, mirroring how the SPA renderer pairs
 *     markers.
 */
const BOLDED_DIGIT_RUN = /\*\*(?:[^*]|\*(?!\*))*?\d(?:[^*]|\*(?!\*))*?\*\*/;

export default async function clinicalNumericsBolded(output, _context) {
  const answer = extractAnswer(output);
  if (!answer) {
    // No answer payload — schemaValid will catch this; not our concern.
    return pass('no Answer-shaped payload to inspect');
  }
  const summary = typeof answer.summary === 'string' ? answer.summary : '';
  if (summary === '') {
    return pass('empty summary — nothing to bold');
  }

  const mentionsNumeric = NUMERIC_PATTERNS.some(re => re.test(summary));
  if (!mentionsNumeric) {
    return pass('summary contains no detectable clinical numeric');
  }

  if (BOLDED_DIGIT_RUN.test(summary)) {
    return pass('summary bolds at least one clinical numeric run');
  }

  return fail(
    `summary mentions a clinical numeric but has no markdown-bolded value. `
    + `summary: "${summary.slice(0, 200)}"`,
  );
}
