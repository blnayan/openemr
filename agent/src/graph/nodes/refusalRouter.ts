/**
 * Refusal router — deterministic out-of-scope classifier.
 *
 * Runs before any FHIR tool call so refusals don't exfiltrate patient data.
 * Covers five classes from USERS.md §UC-7:
 *
 *   1. wrong_patient        — question names a person other than the JWT-bound patient
 *   2. order_entry          — write actions (orders, prescriptions, refills)
 *   3. multi_patient        — enumeration across patients ("list every patient…")
 *   4. general_knowledge    — questions answerable from a textbook, not this chart
 *   5. off_corpus_authority — question explicitly names a guideline body the
 *                             agent's corpus does not cover (ACC/AHA, USPSTF,
 *                             AAFP, NICE, ACOG, JNC-8, KDIGO, GOLD, …). Without
 *                             this gate, the agent will substitute its ADA
 *                             corpus and answer "Per ADA…" when the user asked
 *                             for ACC/AHA — a hallucinated authority swap that
 *                             a clinician relying on the answer would miss.
 *
 * The router is intentionally pattern-based (no LLM call) so:
 *   - it is deterministic and unit-testable
 *   - it is fast enough to live in the hot path
 *   - it cannot itself hallucinate a refusal that leaks chart data
 */

export type RefusalReason =
  | 'wrong_patient'
  | 'order_entry'
  | 'multi_patient'
  | 'general_knowledge'
  | 'off_corpus_authority';

export interface RefusalDecision {
  reason: RefusalReason;
  /** Human-readable refusal text, written to satisfy the keywords in USERS.md §UC-7. */
  message: string;
}

export interface PatientName {
  given: string | null;
  family: string | null;
}

const ORDER_ENTRY_RE =
  /\b(order|orders|prescribe|prescribing|refill|refills|place\s+(?:an?\s+)?(?:order|panel|test|prescription))\b/;

// Tightened: must mention an actual orderable thing alongside the verb, so
// "order of operations" or "in order to" don't trip the refusal.
const ORDERABLE_NOUN_RE =
  /\b(panel|labs?|test|tests|cbc|bmp|cmp|lipid|x-?ray|ekg|ecg|mri|ct\b|prescription|prescriptions|medication|medications?|rx|imaging)\b/;

const MULTI_PATIENT_RE =
  /\b(every|all|list|show|enumerate)\s+(?:the\s+|every\s+)?patients?\b|\bpatient\s+roster\b|\bevery\s+patient\b.*\bdatabase\b|\ball\s+patients?\s+(?:in|with)\b/;

const GENERAL_KNOWLEDGE_RE =
  /^\s*(?:what(?:'s|s|\s+is)|how\s+much\s+is|define)\s+(?:a\s+|an\s+|the\s+)?(normal|typical|average|standard|definition\s+of|range\s+of|cutoff(?:\s+for)?)\b/;

/**
 * Authorities the corpus does NOT cover. ADA is the only authority in
 * the current Pinecone index; explicit mention of any of these is a
 * signal that the user wants something the agent literally cannot
 * source. The keys are matched case-insensitively against the question.
 *
 * Edit alongside the corpus registry — adding a guideline body to
 * Pinecone means dropping it from this list (and probably renaming the
 * refusal reason to be source-aware).
 */
const OFF_CORPUS_AUTHORITIES: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\bacc\s*\/\s*aha\b|\bamerican\s+heart\s+association\b|\bamerican\s+college\s+of\s+cardiology\b/i, label: 'ACC/AHA' },
  { pattern: /\buspstf\b|\bu\.?s\.?\s+preventive\s+services\s+task\s+force\b/i, label: 'USPSTF' },
  { pattern: /\baafp\b|\bamerican\s+academy\s+of\s+family\s+physicians\b/i, label: 'AAFP' },
  { pattern: /\bacog\b/i, label: 'ACOG' },
  { pattern: /\bnice\s+guideline\b|\bnational\s+institute\s+for\s+health\s+and\s+care\s+excellence\b/i, label: 'NICE' },
  { pattern: /\bjnc[-\s]*8\b|\bjnc[-\s]*7\b|\bjoint\s+national\s+committee\b/i, label: 'JNC' },
  { pattern: /\bkdigo\b/i, label: 'KDIGO' },
  { pattern: /\bgold\s+(?:report|copd)\b/i, label: 'GOLD' },
  { pattern: /\baasld\b/i, label: 'AASLD' },
  { pattern: /\bidsa\b/i, label: 'IDSA' },
  { pattern: /\bnccn\b/i, label: 'NCCN' },
  { pattern: /\bendocrine\s+society\b/i, label: 'Endocrine Society' },
  { pattern: /\bsurviving\s+sepsis(?:\s+campaign)?\b/i, label: 'Surviving Sepsis Campaign' },
  // Generic catch-all for medical-society naming patterns we haven't
  // seen yet. "American College of Radiology / Surgeons / Physicians",
  // "European Society of Cardiology", "International Association for
  // <X>", "World Health Organization", etc. Specific authorities above
  // win on label specificity; this only fires when no specific match
  // hit. Without it the wrong_patient Title-Case-bigram check below
  // would fire on "American College" and emit a person-name refusal —
  // which is wrong AND leaks the impression that the org is a person.
  {
    pattern:
      /\b(?:american|european|international|world|royal|national|british)\s+(?:college|society|academy|association|institute)\s+(?:of|for|on)\s+\w+/i,
    label: 'specialty society',
  },
];

const TITLE_CASE_BIGRAM_RE = /\b[A-Z][a-z]{2,}\s+[A-Z][a-z]{2,}\b/g;

/**
 * Tokens that, when they appear as the SECOND word of a Title-Case
 * bigram, mean the bigram is almost certainly an organization or
 * guideline name — not a person. Skips wrong_patient on those.
 *
 * "Joint Commission" → org. "Joint Smith" — implausible. "Sepsis
 * Campaign" → guideline. "Lee Smith" → person.
 */
const ORG_TOKEN_TAIL = new Set([
  'College', 'Society', 'Academy', 'Association', 'Committee',
  'Foundation', 'Council', 'Institute', 'Hospital', 'Clinic',
  'Organization', 'Service', 'Center', 'Centre', 'Network',
  'Department', 'Bureau', 'Commission', 'Campaign',
]);
/**
 * Tokens that, when they appear as the FIRST word of a Title-Case
 * bigram, are likewise org/guideline-shaped. "American X", "National X",
 * "International X", "Surviving X" are organizational by convention;
 * these are not people.
 */
const ORG_TOKEN_HEAD = new Set([
  'American', 'European', 'International', 'World', 'Royal', 'National',
  'British', 'Joint', 'Surviving', 'Federal', 'Global',
]);

export function classifyOutOfScope(
  question: string,
  patient: PatientName,
): RefusalDecision | null {
  const q = question.toLowerCase().trim();

  // 1. Order entry / write actions
  if (ORDER_ENTRY_RE.test(q) && ORDERABLE_NOUN_RE.test(q)) {
    return {
      reason: 'order_entry',
      message:
        "I'm read-only — I cannot order tests or place prescriptions. Use the orders panel to place that.",
    };
  }

  // 2. Multi-patient enumeration
  if (MULTI_PATIENT_RE.test(q)) {
    return {
      reason: 'multi_patient',
      message:
        "I can only answer questions about the current patient on screen — I cannot enumerate other patients. For a panel-level view, use the patient roster.",
    };
  }

  // 3. General-knowledge / out-of-domain
  if (GENERAL_KNOWLEDGE_RE.test(q)) {
    return {
      reason: 'general_knowledge',
      message:
        "I'm scoped to this patient's structured chart data. General clinical guidance is out of scope; please consult your institution's reference.",
    };
  }

  // 4. Off-corpus authority — question explicitly names a guideline
  //    body the agent's Pinecone index doesn't cover. Refusing here
  //    prevents the silent ADA-substitution hallucination.
  for (const { pattern, label } of OFF_CORPUS_AUTHORITIES) {
    if (pattern.test(question)) {
      return {
        reason: 'off_corpus_authority',
        message:
          `My retrieval corpus only covers the ADA Standards of Care in Diabetes. `
          + `I cannot answer ${label}-specific questions; please consult the ${label} guideline directly.`,
      };
    }
  }

  // 5. Wrong-patient — any Title-Case bigram that does not match the JWT
  //    patient's name AND doesn't look organizational. Without the
  //    organizational filter, "American College" and "Surviving Sepsis"
  //    would trigger a person-name refusal ("please open his chart for
  //    American College") — which is both wrong and confusing.
  if (patient.given && patient.family) {
    const given = patient.given.toLowerCase();
    const family = patient.family.toLowerCase();
    for (const m of question.matchAll(TITLE_CASE_BIGRAM_RE)) {
      const candidate = m[0];
      const lc = candidate.toLowerCase();
      const matchesCurrent = lc.includes(given) || lc.includes(family);
      if (matchesCurrent) continue;
      const [head, tail] = candidate.split(/\s+/);
      if (
        (head !== undefined && ORG_TOKEN_HEAD.has(head))
        || (tail !== undefined && ORG_TOKEN_TAIL.has(tail))
      ) {
        // Organization, not a person. Skip without refusal.
        continue;
      }
      return {
        reason: 'wrong_patient',
        message: `I can only answer questions about the current patient. For ${candidate}, please open his chart.`,
      };
    }
  }

  return null;
}
