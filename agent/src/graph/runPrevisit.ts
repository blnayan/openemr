/**
 * runPrevisit — the auto-load flow when the sidebar mounts.
 *
 * 1. Fan out the seven FHIR tools in parallel (no LLM choice — speed).
 * 2. Run check_drug_interactions if RxNorm codes were available.
 * 3. Compute the encounter delta (computeEncounterDiff).
 * 4. Run the deterministic Layer 2 clinical-rule engine.
 * 5. Single LLM call (or stub) → AnswerSchema with ≤5 claims focused on
 *    "what changed since last visit + anything urgent".
 * 6. Verify (Layer 1) → return finalized answer + tool transcript.
 */

import { TOOL_REGISTRY } from '../tools/index.js';
import type { ToolContext, ToolResult } from '../tools/types.js';
import { computeEncounterDiff, flattenDiff, type EncounterDiff } from '../clinical/EncounterDiff.js';
import { computeBaselineHighlights, type BaselineHighlights } from '../clinical/BaselineHighlights.js';
import { citationIdsForRow } from '../clinical/rowCitations.js';
import { ClinicalRuleEngine, type RuleResult } from '../verification/ClinicalRuleEngine.js';
import { verifyLayer1 } from '../verification/verifyLayer1.js';
import type { Answer, Claim } from '../schemas/AnswerSchema.js';
import { IntakeFormSchema, type IntakeForm } from '../schemas/IntakeFormSchema.js';
import { LabPdfSchema, type LabPdf } from '../schemas/LabPdfSchema.js';
import type { LlmInvoker } from '../llm/AgentLlmClient.js';
import type { SidecarReader } from './supervisor/types.js';

export interface PrevisitSection {
  label: string;
  /** Emitted when the section is empty so the UI can render a benign note. */
  emptyMessage: string;
  claims: Claim[];
}

export interface PrevisitSections {
  actionItems: PrevisitSection;
  activeProblems: PrevisitSection;
  currentMedications: PrevisitSection;
}

/**
 * Latest sidecar payload captured during a previsit pull. Surfaced so the
 * SSE wire layer can map deterministic FHIR rows back to the bbox of the
 * matching field in the source PDF — the per-claim citation_bboxes that
 * drive the "click chip → jump to highlighted region" modal flow.
 */
export interface PrevisitSidecarPayloads {
  readonly lab: { readonly extractionId: string; readonly documentId: number | null; readonly documentName: string | null; readonly payload: LabPdf } | null;
  readonly intake: { readonly extractionId: string; readonly documentId: number | null; readonly documentName: string | null; readonly payload: IntakeForm } | null;
}

export interface PrevisitResult {
  /** Flat AnswerSchema for legacy/test compatibility. */
  answer: Answer;
  /** New: three-section structured output for the sidebar UI. */
  sections: PrevisitSections;
  toolResults: ToolResult[];
  diff: EncounterDiff;
  baseline: BaselineHighlights;
  patientLabel: string;
  ruleFindings: RuleResult[];
  /** True when the LLM produced the answer; false when we used the stub. */
  llmDriven: boolean;
  /** Latest lab + intake sidecar payloads, when a SidecarReader was injected. */
  sidecar: PrevisitSidecarPayloads;
}

const PREVISIT_TOOLS_FIRST_PASS = [
  'get_patient_summary',
  'get_active_problems',
  'get_medications',
  'get_recent_labs',
  'get_vitals',
  'get_allergies',
  'get_recent_encounters',
];


export async function runPrevisit(
  context: ToolContext,
  llm: LlmInvoker | null,
  sidecarReader: SidecarReader | null = null,
): Promise<PrevisitResult> {
  // ── Step 1: fan-out FHIR tools (+ sidecar payloads) in parallel ────────
  // The sidecar reads run alongside the FHIR fanout — they're best-effort
  // and only used to decorate previsit chips with bboxes downstream, so
  // a null reader / 404 sidecar / schema-invalid payload silently lands
  // as "no bbox decoration" rather than failing the turn.
  const sidecarReadsP = sidecarReader === null
    ? Promise.resolve<PrevisitSidecarPayloads>({ lab: null, intake: null })
    : readSidecarPayloads(sidecarReader, context.pid);
  const firstPass = await Promise.all(
    PREVISIT_TOOLS_FIRST_PASS.map(async (name) => {
      const fn = TOOL_REGISTRY[name];
      if (!fn) return { ok: false, reason: 'unknown_tool', tool: name } satisfies ToolResult;
      try {
        return await fn({}, context);
      } catch (err) {
        return {
          ok: false,
          reason: err instanceof Error ? err.message : 'tool_threw',
          tool: name,
        } satisfies ToolResult;
      }
    }),
  );
  const sidecar = await sidecarReadsP;

  // ── Step 2: DDI lookup if we have RxNorm codes ─────────────────────────
  const rxnormCodes = extractRxNormCodes(firstPass);
  let ddiResult: ToolResult | null = null;
  if (TOOL_REGISTRY['check_drug_interactions']) {
    try {
      ddiResult = await TOOL_REGISTRY['check_drug_interactions']!({ rxnorm_codes: rxnormCodes }, context);
    } catch (err) {
      ddiResult = {
        ok: false,
        reason: err instanceof Error ? err.message : 'tool_threw',
        tool: 'check_drug_interactions',
      };
    }
  }
  const toolResults: ToolResult[] = ddiResult ? [...firstPass, ddiResult] : [...firstPass];

  // ── Step 3: encounter delta + baseline highlights ──────────────────────
  const diff = computeEncounterDiff(toolResults);
  const baseline = computeBaselineHighlights(toolResults);
  const patientLabel = renderPatientLabel(toolResults);

  // ── Step 4: deterministic clinical rules ───────────────────────────────
  const ruleFindings = new ClinicalRuleEngine().evaluate(toolResults);

  // ── Step 5: build the three pre-visit sections ─────────────────────────
  // Section A — Action items: deltas + clinical-rule findings.
  // Section B — Active problems: from get_active_problems.
  // Section C — Current medications: from get_medications.
  const sections = buildSections(diff, baseline, ruleFindings, toolResults);

  // ── Step 6: optional LLM-polished summary line ─────────────────────────
  let llmDriven = false;
  let summaryLine = composeSummaryLine(patientLabel, diff, sections);
  if (llm) {
    const polished = await callLlmForSummary(llm, patientLabel, diff, sections);
    if (polished) {
      summaryLine = polished;
      llmDriven = true;
    }
  }

  // Flat answer for back-compat (used by Layer 1 grounding + tests).
  let answer: Answer = {
    summary: summaryLine,
    claims: [
      ...sections.actionItems.claims,
      ...sections.activeProblems.claims,
      ...sections.currentMedications.claims,
    ],
    conflicts: [],
    data_gaps: [],
    assumptions: [],
    evidence_catalog: [],
    followup_suggestions: pickPrevisitFollowups(sections),
    confidence: diff.baseline ? 'low' : 'medium',
  };

  // ── Step 7: Layer 1 grounding ──────────────────────────────────────────
  const validIds = collectValidIds(toolResults);
  const grounded = verifyLayer1(answer, validIds);
  if (!grounded.pass) {
    // Strip claims with bad citations and emit a footer note via summary.
    const cleaned = answer.claims.filter(c =>
      c.citation_ids.every(cid =>
        cid.startsWith('rule:') || cid.startsWith('doc:') || validIds.has(cid),
      ),
    );
    answer = { ...answer, claims: cleaned };
  }

  return { answer, sections, toolResults, diff, baseline, patientLabel, ruleFindings, llmDriven, sidecar };
}

async function readSidecarPayloads(
  reader: SidecarReader,
  pid: number,
): Promise<PrevisitSidecarPayloads> {
  const [labRow, intakeRow] = await Promise.all([
    reader.readLatest({ pid, docType: 'lab_pdf' }).catch(() => null),
    reader.readLatest({ pid, docType: 'intake_form' }).catch(() => null),
  ]);
  const lab = (() => {
    if (labRow === null) return null;
    const parsed = LabPdfSchema.safeParse(labRow.extractedJson);
    if (!parsed.success) return null;
    return {
      extractionId: labRow.extractionId,
      documentId: labRow.documentId,
      documentName: labRow.documentName,
      payload: parsed.data,
    };
  })();
  const intake = (() => {
    if (intakeRow === null) return null;
    const parsed = IntakeFormSchema.safeParse(intakeRow.extractedJson);
    if (!parsed.success) return null;
    return {
      extractionId: intakeRow.extractionId,
      documentId: intakeRow.documentId,
      documentName: intakeRow.documentName,
      payload: parsed.data,
    };
  })();
  return { lab, intake };
}

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

const MAX_PER_SECTION = 5;

function buildSections(
  diff: EncounterDiff,
  baseline: BaselineHighlights,
  ruleFindings: RuleResult[],
  toolResults: ToolResult[],
): PrevisitSections {
  return {
    actionItems: buildActionItems(diff, ruleFindings),
    activeProblems: buildActiveProblems(baseline),
    currentMedications: buildCurrentMedications(baseline, toolResults),
  };
}

function buildActionItems(diff: EncounterDiff, ruleFindings: RuleResult[]): PrevisitSection {
  const claims: Claim[] = [];

  // Layer 2 rule findings always lead — DDIs, allergy conflicts, dose anomalies.
  for (const r of ruleFindings) {
    if (claims.length >= MAX_PER_SECTION) break;
    claims.push({
      text: r.description,
      citation_ids: [r.citationId],
      severity: 'urgent',
    });
  }

  // Then encounter deltas: new problems, med adds/stops, abnormal labs, allergies.
  for (const item of flattenDiff(diff)) {
    if (claims.length >= MAX_PER_SECTION) break;
    claims.push({
      text: item.text,
      citation_ids: item.citationIds,
      severity: item.severity,
    });
  }

  return {
    label: diff.baseline
      ? 'Action items'
      : (diff.daysSinceLastEncounter !== null
          ? `Action items since last visit (${diff.daysSinceLastEncounter}d ago)`
          : 'Action items since last visit'),
    emptyMessage: diff.baseline
      ? 'No prior encounter on file to compare against — first documented visit.'
      : 'No new findings or changes since last visit.',
    claims,
  };
}

function buildActiveProblems(baseline: BaselineHighlights): PrevisitSection {
  const claims: Claim[] = baseline.problems.slice(0, MAX_PER_SECTION).map(p => ({
    text: stripPrefix(p.text, 'Active problem: '),
    citation_ids: p.citationIds,
    severity: p.severity,
  }));
  return {
    label: 'Active medical problems',
    emptyMessage: 'No active problems on file.',
    claims,
  };
}

function buildCurrentMedications(baseline: BaselineHighlights, toolResults: ToolResult[]): PrevisitSection {
  // For meds we want a slightly fuller view than baseline highlights — show
  // up to MAX_PER_SECTION active meds, prefer the high-risk-first ordering
  // from BaselineHighlights, then fill in from the rest of the active list.
  const seen = new Set<string>();
  const claims: Claim[] = [];

  for (const m of baseline.medications) {
    if (claims.length >= MAX_PER_SECTION) break;
    const cid = m.citationIds[0];
    if (cid && seen.has(cid)) continue;
    if (cid) seen.add(cid);
    claims.push({
      text: stripPrefix(m.text, 'On '),
      citation_ids: m.citationIds,
      severity: m.severity,
    });
  }

  const meds = toolResults.find(r => r.ok && r.tool === 'get_medications');
  if (meds && meds.ok && claims.length < MAX_PER_SECTION) {
    for (const row of meds.rows) {
      if (claims.length >= MAX_PER_SECTION) break;
      const cid = String(row.id);
      if (seen.has(cid)) continue;
      seen.add(cid);
      const drug = String(row['drug_name'] ?? 'unspecified medication');
      const dose = row['dosage'] ?? (row['dose_mg'] ? `${row['dose_mg']} mg` : null);
      claims.push({
        text: dose ? `${drug} ${dose}.` : `${drug}.`,
        citation_ids: citationIdsForRow(row),
        severity: 'info',
      });
    }
  }

  return {
    label: 'Current medications',
    emptyMessage: 'No active medications on file.',
    claims,
  };
}

function stripPrefix(text: string, prefix: string): string {
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

// ---------------------------------------------------------------------------
// Summary line
// ---------------------------------------------------------------------------

function composeSummaryLine(
  patientLabel: string,
  diff: EncounterDiff,
  sections: PrevisitSections,
): string {
  const actionCount = sections.actionItems.claims.length;
  const probCount = sections.activeProblems.claims.length;
  const medCount = sections.currentMedications.claims.length;

  const since = diff.baseline
    ? 'first documented visit'
    : (diff.anchorDate ? `last visit ${diff.daysSinceLastEncounter}d ago, ${diff.anchorDate}` : 'unknown last visit');

  const counts = [
    actionCount > 0 ? `${actionCount} action item(s)` : 'no action items',
    `${probCount} active problem(s)`,
    `${medCount} active med(s)`,
  ].join(', ');

  return `${patientLabel}. ${counts} (${since}).`;
}

function pickPrevisitFollowups(sections: PrevisitSections): string[] {
  const out: string[] = [];
  if (sections.actionItems.claims.length > 0) out.push('Tell me more about the action items.');
  if (sections.activeProblems.claims.length > 0) out.push('What meds address each problem?');
  if (sections.currentMedications.claims.length > 0) out.push('Any drug-interaction concerns?');
  if (out.length === 0) out.push('Show recent labs.');
  return out.slice(0, 3);
}

// ---------------------------------------------------------------------------
// Optional LLM-polished summary line
// ---------------------------------------------------------------------------

const SUMMARY_SYSTEM = [
  'You write a single-sentence pre-visit headline (<=180 chars) for a primary-care doctor.',
  'You receive: patient label, anchor (last visit), counts per section, and the section item lists.',
  'Reply with ONE plain sentence — no JSON, no quotes, no formatting. Just the sentence.',
  'Mention the most important action item if there are any; otherwise note the baseline.',
].join('\n');

async function callLlmForSummary(
  llm: LlmInvoker,
  patientLabel: string,
  diff: EncounterDiff,
  sections: PrevisitSections,
): Promise<string | null> {
  const renderClaims = (cs: Claim[]): string => cs.length === 0
    ? '  (none)'
    : cs.map((c, i) => `  ${i + 1}. [${c.severity}] ${c.text}`).join('\n');

  const userMessage = [
    `Patient: ${patientLabel}`,
    `Anchor: ${diff.baseline ? 'first documented visit' : `${diff.daysSinceLastEncounter}d since last visit (${diff.anchorDate})`}`,
    '',
    `Action items (${sections.actionItems.claims.length}):`,
    renderClaims(sections.actionItems.claims),
    '',
    `Active problems (${sections.activeProblems.claims.length}):`,
    renderClaims(sections.activeProblems.claims),
    '',
    `Current medications (${sections.currentMedications.claims.length}):`,
    renderClaims(sections.currentMedications.claims),
    '',
    'Write the headline.',
  ].join('\n');

  try {
    const response = await llm.chat([
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: userMessage },
    ]);
    const text = response.content.trim().replace(/^["']|["']$/g, '');
    if (text.length === 0 || text.length > 250) return null;
    return text;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[agentforge.previsit] summary LLM call failed', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderPatientLabel(toolResults: ToolResult[]): string {
  const summary = toolResults.find(r => r.ok && r.tool === 'get_patient_summary');
  if (!summary || !summary.ok || summary.rows.length === 0) return 'Patient';
  const row = summary.rows[0]!;
  const given = String(row['given_name'] ?? '').trim();
  const family = String(row['family_name'] ?? '').trim();
  const sex = row['sex'] ?? 'unknown';
  const dob = row['dob'] ?? '?';
  const name = (given + ' ' + family).trim() || 'Patient';
  return `${name}, ${sex}, DOB ${dob}`;
}

function extractRxNormCodes(toolResults: ToolResult[]): string[] {
  const meds = toolResults.find(r => r.ok && r.tool === 'get_medications');
  if (!meds || !meds.ok) return [];
  return meds.rows
    .map(r => (typeof r['rxnorm_code'] === 'string' ? r['rxnorm_code'] as string : null))
    .filter((c): c is string => c !== null && c !== '');
}

function collectValidIds(toolResults: ToolResult[]): Set<string> {
  const set = new Set<string>();
  for (const r of toolResults) {
    if (!r.ok) continue;
    for (const row of r.rows) {
      if (typeof row.id === 'string') set.add(row.id);
    }
  }
  return set;
}

