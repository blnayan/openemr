/**
 * routeQuestion — minimal deterministic router for issue 06.
 *
 * Returns `'guideline'` when the question looks like a guideline /
 * recommendation lookup, else `'clinical_data'` (the Week 1 default).
 *
 * Heuristic:
 *   - case-insensitive match against an allow-list of guideline-shaped
 *     phrases / terms (`ADA`, `KDIGO`, `USPSTF`, `AHA/ACC`, `guideline`,
 *     `recommendation`, `target`, `goal`, `should I`, `evidence`, etc.).
 *   - if any phrase appears, route to the evidence-retriever.
 *
 * Why a hand-crafted regex and not an LLM judge: this is the
 * Tuesday-milestone path. The full Pattern A supervisor (issue 11)
 * does LLM-driven worker selection. Until then a deterministic
 * regex is auditable, free, sub-millisecond, and testable.
 *
 * False positives (clinical-data questions wrongly routed to guidelines)
 * are not catastrophic: the synthesizer either grounds the answer in a
 * relevant chunk or produces a low-confidence refusal that the verifier
 * rubber-stamps. False negatives (guideline questions wrongly routed
 * to clinical-data) degrade gracefully to the Week 1 path.
 */

export type QuestionRoute = 'guideline' | 'clinical_data';

const GUIDELINE_MARKERS = [
  // Source-name acronyms — strong signal.
  /\bADA\b/i,
  /\bAHA\b/i,
  /\bACC\b/i,
  /\bAHA\s*\/\s*ACC\b/i,
  /\bKDIGO\b/i,
  /\bUSPSTF\b/i,
  // Guideline/recommendation vocabulary.
  /\bguidelines?\b/i,
  /\brecommendations?\b/i,
  /\brecommends?\b/i,
  /\bevidence(-|\s)based\b/i,
  /\bstandards?\s+of\s+care\b/i,
  // Targets / goals — common phrasing for "what does the guideline say".
  /\bA1[Cc]\s+(target|goal)\b/i,
  /\b(blood\s+pressure|BP)\s+(target|goal)\b/i,
  /\b(LDL|cholesterol)\s+(target|goal)\b/i,
  /\b(target|goal)\b.*\b(adults?|patients?|nonpregnant|elderly)\b/i,
  // Decision-style framing.
  /\bshould\s+(I|we|the\s+patient|clinicians?)\b/i,
  /\bwhen\s+(should|do)\s+(I|we|clinicians?)\b/i,
];

export function routeQuestion(question: string): QuestionRoute {
  const q = question.trim();
  if (q.length === 0) return 'clinical_data';
  for (const re of GUIDELINE_MARKERS) {
    if (re.test(q)) return 'guideline';
  }
  return 'clinical_data';
}
