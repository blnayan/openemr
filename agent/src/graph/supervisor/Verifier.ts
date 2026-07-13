/**
 * Supervisor-level Verifier — runs after the Synthesizer at the
 * supervisor level, fail-closed.
 *
 * For every claim in the synthesizer's draft answer we resolve every
 * citation:
 *
 *   - guideline       → quoted_span must be a substring of the named
 *                       chunk body, whitespace-normalized. Uses the
 *                       existing isSubstringNormalized helper.
 *   - patient_document→ a sidecar extraction row with that extraction_id
 *                       must exist for this pid. The lookup is delegated
 *                       to a PatientDocumentVerifier dependency so tests
 *                       can stub it without touching the DB.
 *   - patient_record  → tool_name + row_index must appear in the
 *                       accumulated clinical-data tool transcripts.
 *                       Re-uses the Week-1 verifier's id format
 *                       (`tool:<name>:row-<n>`).
 *
 * Drop policy:
 *   - A claim is dropped if ANY of its rich `citations` fails to
 *     resolve, OR if any of its legacy `citation_ids` (other than
 *     `rule:*` markers) cannot be matched against the clinical-data
 *     tool transcripts. Rule-style ids (`rule:no-data:*`,
 *     `rule:guideline:*`) are passed through unverified — they're
 *     deterministic markers emitted by the agent itself.
 *   - If more than half of the synthesizer's claims are dropped the
 *     verifier returns a low-confidence refusal answer instead of the
 *     draft; the dropped count is preserved so callers can log it.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

import type { Answer, Claim, Citation } from '../../schemas/AnswerSchema.js';
import { isSubstringNormalized } from '../../verification/guidelineVerifier.js';
import type {
  AccumulatedHandoff,
  ClinicalDataOutput,
  EvidenceRetrieverOutput,
  IntakeExtractorOutput,
  LabExtractorOutput,
} from './types.js';

export interface PatientDocumentVerifier {
  /** True iff a sidecar row with this extraction_id exists for `pid`. */
  exists(input: { readonly pid: number; readonly extractionId: string }):
    Promise<boolean>;
}

export interface VerifierDeps {
  readonly patientDocumentVerifier: PatientDocumentVerifier;
}

export interface VerifyResult {
  readonly answer: Answer;
  readonly droppedClaims: number;
  readonly refused: boolean;
}

export class SupervisorVerifier {
  constructor(private readonly deps: VerifierDeps) {}

  async verify(
    draft: Answer,
    accumulated: readonly AccumulatedHandoff[],
    pid: number,
  ): Promise<VerifyResult> {
    const evidence = pickEvidence(accumulated);
    const clinical = pickClinical(accumulated);
    const intake = pickIntake(accumulated);
    const lab = pickLab(accumulated);
    const chunkBodyById = new Map<string, string>();
    if (evidence) {
      for (const c of evidence.chunks) chunkBodyById.set(c.id, c.body);
    }
    const validToolRowIds = collectValidToolRowIds(clinical);
    const validDocIds = collectValidDocIds(clinical, intake, lab);

    const kept: Claim[] = [];
    let dropped = 0;

    for (const rawClaim of draft.claims) {
      const claim = stripInvalidDocCitations(rawClaim, validDocIds);
      if (claim.citation_ids.length === 0) {
        dropped += 1;
        continue;
      }
      const ok = await this.checkClaim(claim, {
        chunkBodyById,
        validToolRowIds,
        pid,
      });
      if (ok) {
        kept.push(claim);
      } else {
        dropped += 1;
      }
    }

    const total = draft.claims.length;
    if (total > 0 && dropped * 2 > total) {
      return {
        answer: lowConfidenceRefusal(dropped, total),
        droppedClaims: dropped,
        refused: true,
      };
    }

    return {
      answer: {
        summary: draft.summary,
        claims: kept,
        conflicts: draft.conflicts ?? [],
        data_gaps: draft.data_gaps ?? [],
        assumptions: draft.assumptions ?? [],
        evidence_catalog: draft.evidence_catalog ?? [],
        followup_suggestions: draft.followup_suggestions,
        confidence: dropped > 0 ? lowerConfidence(draft.confidence) : draft.confidence,
      },
      droppedClaims: dropped,
      refused: false,
    };
  }

  private async checkClaim(
    claim: Claim,
    ctx: {
      readonly chunkBodyById: Map<string, string>;
      readonly validToolRowIds: Set<string>;
      readonly pid: number;
    },
  ): Promise<boolean> {
    // Verify the rich citations array (if present).
    if (claim.citations) {
      for (const cit of claim.citations) {
        const ok = await this.checkCitation(cit, ctx);
        if (!ok) return false;
      }
    }
    // Verify the legacy citation_ids array. `rule:*` and `doc:*` synthetic
    // markers pass through unverified (rule = post-grounding rules,
    // doc = AgentForge source-document attribution); `tool:*` ids must
    // resolve to a tool row visible in the accumulated transcript.
    for (const cid of claim.citation_ids) {
      if (cid.startsWith('rule:')) continue;
      if (cid.startsWith('doc:')) continue;
      if (!ctx.validToolRowIds.has(cid)) return false;
    }
    return true;
  }

  private async checkCitation(
    cit: Citation,
    ctx: {
      readonly chunkBodyById: Map<string, string>;
      readonly validToolRowIds: Set<string>;
      readonly pid: number;
    },
  ): Promise<boolean> {
    if (cit.type === 'guideline') {
      const body = ctx.chunkBodyById.get(cit.chunk_id);
      if (body === undefined) return false;
      return isSubstringNormalized(cit.quoted_span, body);
    }
    if (cit.type === 'patient_record') {
      return ctx.validToolRowIds.has(cit.citation_id);
    }
    // patient_document
    return await this.deps.patientDocumentVerifier.exists({
      pid: ctx.pid,
      extractionId: cit.extraction_id,
    });
  }
}

interface ValidDocIds {
  readonly lab: ReadonlySet<string>;
  readonly intake: ReadonlySet<string>;
}

/**
 * A `doc:lab-<X>` / `doc:intake-<X>` citation is only legitimate when X
 * matches either the corresponding extractor worker's extractionId or
 * the `source.document_id` of a clinical-tool row that the synthesizer
 * was actually shown. Any other value is the LLM hallucinating
 * source-document attribution onto chart-only data — strip it so the
 * "recent labs #N" pill (the tool-row id) carries the citation
 * unaltered, per the project rule that lab results without a docid in
 * the table render under their original tool-row pill.
 */
function collectValidDocIds(
  clinical: ClinicalDataOutput | null,
  intake: IntakeExtractorOutput | null,
  lab: LabExtractorOutput | null,
): ValidDocIds {
  const labIds = new Set<string>();
  const intakeIds = new Set<string>();
  if (lab && lab.extractionId !== null) labIds.add(lab.extractionId);
  if (intake && intake.extractionId !== null) intakeIds.add(intake.extractionId);
  if (clinical) {
    for (const r of clinical.toolResults) {
      if (!r.ok) continue;
      for (const row of r.rows) {
        const src = row['source'];
        if (!src || typeof src !== 'object' || Array.isArray(src)) continue;
        const kind = (src as { kind?: unknown }).kind;
        if (kind !== 'document') continue;
        const docId = (src as { document_id?: unknown }).document_id;
        if (typeof docId !== 'number' || docId <= 0) continue;
        const idStr = String(docId);
        const toolName = String(row['id']).split(':')[1] ?? '';
        if (toolName === 'get_allergies' || toolName === 'get_medications') {
          intakeIds.add(idStr);
        } else {
          labIds.add(idStr);
        }
      }
    }
  }
  return { lab: labIds, intake: intakeIds };
}

function stripInvalidDocCitations(claim: Claim, valid: ValidDocIds): Claim {
  const filtered = claim.citation_ids.filter(cid => {
    const m = /^doc:(lab|intake)-(\d+)$/.exec(cid);
    if (!m) return true;
    const kind = m[1];
    const id = m[2]!;
    return kind === 'lab' ? valid.lab.has(id) : valid.intake.has(id);
  });
  if (filtered.length === claim.citation_ids.length) return claim;
  return { ...claim, citation_ids: filtered };
}

function pickEvidence(handoffs: readonly AccumulatedHandoff[]): EvidenceRetrieverOutput | null {
  for (let i = handoffs.length - 1; i >= 0; i--) {
    const h = handoffs[i];
    if (h && h.output.worker === 'evidence_retriever') return h.output;
  }
  return null;
}

function pickClinical(handoffs: readonly AccumulatedHandoff[]): ClinicalDataOutput | null {
  for (let i = handoffs.length - 1; i >= 0; i--) {
    const h = handoffs[i];
    if (h && h.output.worker === 'clinical_data') return h.output;
  }
  return null;
}

function pickIntake(handoffs: readonly AccumulatedHandoff[]): IntakeExtractorOutput | null {
  for (let i = handoffs.length - 1; i >= 0; i--) {
    const h = handoffs[i];
    if (h && h.output.worker === 'intake_extractor') return h.output;
  }
  return null;
}

function pickLab(handoffs: readonly AccumulatedHandoff[]): LabExtractorOutput | null {
  for (let i = handoffs.length - 1; i >= 0; i--) {
    const h = handoffs[i];
    if (h && h.output.worker === 'lab_extractor') return h.output;
  }
  return null;
}

function collectValidToolRowIds(clinical: ClinicalDataOutput | null): Set<string> {
  const set = new Set<string>();
  if (clinical === null) return set;
  for (const r of clinical.toolResults) {
    if (!r.ok) continue;
    for (const row of r.rows) {
      if (typeof row['id'] === 'string') set.add(row['id']);
    }
  }
  return set;
}

function lowerConfidence(c: 'high' | 'medium' | 'low'): 'high' | 'medium' | 'low' {
  if (c === 'high') return 'medium';
  if (c === 'medium') return 'low';
  return 'low';
}

function lowConfidenceRefusal(dropped: number, total: number): Answer {
  return {
    summary:
      'I drafted an answer but more than half of its claims could not be verified '
      + 'against the cited sources. Refusing rather than presenting unverified content.',
    claims: [
      {
        text: `${dropped} of ${total} draft claims failed citation resolution and were dropped.`,
        citation_ids: ['rule:no-data:supervisor-verifier'],
        severity: 'info',
      },
    ],
    conflicts: [],
    data_gaps: [],
    assumptions: [],
    evidence_catalog: [],
    followup_suggestions: [],
    confidence: 'low',
  };
}
