/**
 * AnswerSchema — structured output contract for every chat turn.
 *
 * Every claim must carry at least one citation. The schema supports two
 * citation surfaces, both addressable from a single `Claim` shape:
 *
 *   1. `citation_ids: string[]` — REQUIRED, min 1. The legacy stringly-
 *      typed form (`tool:<name>:row-<n>` or `rule:<category>:<id>`).
 *      Semantically these are the `patient_record` arm of the W2_PRD
 *      citation contract: a tool-call result row or a verifier-injected
 *      rule finding. The Week 1 clinical-data path (planner /
 *      runFollowup / runPrevisit / verifier / formatter) uses this
 *      surface exclusively.
 *
 *   2. `citations: Citation[]` — OPTIONAL. The rich discriminated-union
 *      form (W2_PRD §"Citation contract") used by the Week 2 evidence-
 *      retriever path so a claim can carry a verifiable `guideline`
 *      citation with chunk_id + section_id + quoted_span. Patient-
 *      document citations with bbox + citation_confidence go here too.
 *
 * The two-surface design is deliberate and bounded: we don't ship two
 * parallel `Answer` types, and we keep the Week 1 graph compiling
 * unchanged. Pattern-A supervisor wiring (issue 11) will fold the
 * legacy form into the rich form once all worker paths emit `Citation`
 * objects natively. Until then, every Week 1 claim still carries a
 * citation (via `citation_ids`), and every Week 2 guideline claim
 * additionally carries a verifiable rich citation in `citations`.
 */

import { z } from 'zod';
import { CitationSchema, type Citation } from './CitationSchema.js';

// Citation ID format. The slug part of a `rule:` citation may include
// dots and slashes because guideline section IDs (e.g. `6.3a`, `13.10`)
// commonly carry them — rejecting them was costing entire turns when
// the synthesizer cited a guideline section by its native id.
//
// The `rule:` category portion accepts hyphens (`[a-z-]+`) because
// existing AgentForge conventions use hyphenated categories — the
// supervisor's verifier emits `rule:no-data:supervisor-verifier` for
// "claims dropped during verification" stub claims, and the DDI
// rubric expects `rule:no-data:check_drug_interactions`. The
// pre-fix regex `[a-z]+` would silently drop those legitimate
// citations, fail Zod validation, and surface as
// agent_internal_error (caught in eval as ANTI-HALLUCINATION-5).
export const CitationIdSchema = z.string().regex(
  /^(tool:[a-z_]+:row-\d+|rule:[a-z-]+:[a-zA-Z0-9_./:-]+|doc:(lab|intake)-\d+)$/,
  'Citation ID must match tool:<name>:row-<n>, doc:(lab|intake)-<id>, or rule:<category>:<id>',
);

export const ClaimSchema = z.object({
  text: z.string().min(1).max(500),
  citation_ids: z.array(CitationIdSchema).min(1),
  /**
   * Server-only: streamed on SSE / stored on transcripts once the catalog
   * materializes citation_ids → ev_n. Omit from synthesizer JSON — sanitizer strips.
   */
  evidence_refs: z.array(z.string()).optional(),
  citations: z.array(CitationSchema).optional(),
  finding_confidence: z.enum(['high', 'medium', 'low']).optional(),
  uncertainty_reason: z.string().max(300).optional(),
  severity: z.enum(['info', 'attention', 'urgent']),
});

export const ConflictSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  severity: z.enum(['info', 'attention', 'urgent']),
  message: z.string().min(1).max(400),
  evidence_refs: z.array(z.string().min(1)).default([]),
  resolution_hint: z.string().max(300).optional(),
});

export const DataGapSchema = z.object({
  id: z.string().min(1),
  message: z.string().min(1).max(300),
  severity: z.enum(['info', 'attention', 'urgent']),
  blocks: z.array(z.string().min(1)).default([]),
});

export const AssumptionSchema = z.object({
  id: z.string().min(1),
  message: z.string().min(1).max(300),
});

export const EvidenceNodeSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['chart_row', 'guideline_span', 'patient_document_span', 'derived_fact']),
  trust_level: z.enum(['primary_chart', 'doc_extracted', 'guideline', 'derived']),
  label: z.string().min(1).max(250),
  provenance_path: z.array(z.string()).default([]),
  source_timestamp: z.string().nullable().optional(),
});

/**
 * Confidence is canonically the enum 'high' | 'medium' | 'low'.
 * Some VLM/LLM tool-calling shapes emit a numeric confidence
 * (0..1) instead of the enum even when the schema is bound.
 * Coerce numbers into buckets so a single off-spec emission
 * doesn't blow up the supervisor's synthesizer retry loop.
 */
const ConfidenceSchema = z.preprocess((v) => {
  if (typeof v === 'number' && Number.isFinite(v)) {
    if (v >= 0.7) return 'high';
    if (v >= 0.4) return 'medium';
    return 'low';
  }
  if (typeof v === 'string') {
    const lc = v.trim().toLowerCase();
    if (lc === 'high' || lc === 'medium' || lc === 'low') return lc;
  }
  return v;
}, z.enum(['high', 'medium', 'low']));

export const AnswerSchema = z.object({
  summary: z.string().min(1).max(1000),
  claims: z.array(ClaimSchema),
  conflicts: z.array(ConflictSchema).default([]),
  data_gaps: z.array(DataGapSchema).default([]),
  assumptions: z.array(AssumptionSchema).default([]),
  evidence_catalog: z.array(EvidenceNodeSchema).default([]),
  followup_suggestions: z.array(z.string().max(150)).max(3),
  confidence: ConfidenceSchema,
});

// Mirror of CitationIdSchema's regex — kept inline for the sanitizer's
// hot path. Both must match exactly; update them together.
const CITATION_ID_RE = /^(tool:[a-z_]+:row-\d+|rule:[a-z-]+:[a-zA-Z0-9_./:-]+|doc:(lab|intake)-\d+)$/;

/**
 * Make a best-effort pass at coercing an LLM-produced object into the
 * AnswerSchema shape. Used by the supervisor's synthesizer to recover
 * from off-spec emissions instead of failing the whole turn:
 *
 *   - followup_suggestions: default missing/non-array to []; filter to
 *     non-empty strings; slice to first 3; clip each to 150 chars.
 *   - claims[].citation_ids: filter entries that don't match the
 *     canonical regex (e.g. `general_knowledge`, `rule:Guideline:foo`,
 *     slugs with `/`). Drop the whole claim if no valid id remains
 *     (each claim must carry at least one citation by contract).
 *
 * Invariant: NEVER touches the strict AnswerSchema itself — the eval
 * rubric (`evals/rubrics/schemaValid.js`) still uses the strict
 * schema so off-spec model output gets a negative eval signal even when
 * runtime recovers from it.
 */
export function sanitizeAnswerInput(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const obj = { ...(raw as Record<string, unknown>) };

  // followup_suggestions: cosmetic UI chips. Default missing → [].
  const fs = obj['followup_suggestions'];
  if (fs === undefined || fs === null) {
    obj['followup_suggestions'] = [];
  } else if (Array.isArray(fs)) {
    obj['followup_suggestions'] = fs
      .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
      .slice(0, 3)
      .map(s => s.length > 150 ? s.slice(0, 150) : s);
  } else {
    obj['followup_suggestions'] = [];
  }

  // vNext additive arrays: default missing/non-array to [] so worker outputs
  // can omit them without failing the turn.
  const additiveArrays = [
    'conflicts',
    'data_gaps',
    'assumptions',
    'evidence_catalog',
  ] as const;
  for (const key of additiveArrays) {
    const v = obj[key];
    if (!Array.isArray(v)) obj[key] = [];
  }

  // claims: drop citation_ids that don't match the canonical regex; drop
  // the whole claim if it would end up with no valid citations.
  const claims = obj['claims'];
  if (Array.isArray(claims)) {
    const cleaned: unknown[] = [];
    for (const c of claims) {
      if (typeof c !== 'object' || c === null) continue;
      const claim = c as Record<string, unknown>;
      const ids = claim['citation_ids'];
      if (!Array.isArray(ids)) {
        const next: Record<string, unknown> = { ...claim };
        delete next['evidence_refs'];
        cleaned.push(next);
        continue;
      }
      const valid = ids.filter(id => typeof id === 'string' && CITATION_ID_RE.test(id));
      if (valid.length === 0) continue;
      const next: Record<string, unknown> = { ...claim, citation_ids: valid };
      delete next['evidence_refs'];
      // Citation-shape drift recovery. The synthesizer LLM (Sonnet via
      // OpenRouter, observed 2026-05-09 → 2026-05-10) sometimes emits
      // patient_document citations that pass every required field
      // EXCEPT `citation_confidence` — the schema requires a number on
      // [0, 1] but the LLM omits it on a fraction of claims, throwing
      // the whole answer back through the retry path and ultimately
      // surfacing as `agent_internal_error` to the client. Defaulting
      // missing values to 0 ("unverifiable; the verifier won't trust
      // the bbox blindly") matches the conservative posture of the
      // existing `unverifiable` enum used elsewhere in the citation
      // contract. This is sanitizer-as-shock-absorber, NOT a schema
      // weakening — every other field still has to be present.
      const citations = next['citations'];
      if (Array.isArray(citations)) {
        next['citations'] = citations.map(cit => {
          if (typeof cit !== 'object' || cit === null) return cit;
          const c = cit as Record<string, unknown>;
          if (c['type'] === 'patient_document' && (c['citation_confidence'] === undefined || c['citation_confidence'] === null)) {
            return { ...c, citation_confidence: 0 };
          }
          return c;
        });
      }
      cleaned.push(next);
    }
    obj['claims'] = cleaned;
  }

  return obj;
}

export type Answer = z.infer<typeof AnswerSchema>;
export type Claim = z.infer<typeof ClaimSchema>;
export type Conflict = z.infer<typeof ConflictSchema>;
export type DataGap = z.infer<typeof DataGapSchema>;
export type Assumption = z.infer<typeof AssumptionSchema>;
export type EvidenceNode = z.infer<typeof EvidenceNodeSchema>;

export type { Citation };
