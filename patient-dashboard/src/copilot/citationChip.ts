/**
 * Citation-chip resolver — pure mapping from a citation_id string to the
 * `{ kind, label }` pair the chip renderer uses for color split + copy.
 *
 * Citation ID format (from `agent/src/schemas/AnswerSchema.ts`):
 *
 *   tool:<name>:row-<n>            e.g. tool:medication_list:row-3
 *   rule:<category>:<slug>          e.g. rule:diabetes:6.3a
 *   doc:lab-<n>                     e.g. doc:lab-42
 *   doc:intake-<n>                  e.g. doc:intake-7
 *
 * Chip kind drives the color split (W2 PRD §"Citation chips"):
 *
 *   - `clinical` (blue)   — chart-row / rule citations the dashboard's
 *                           grid already shows. Color: --blue / white.
 *   - `document` (amber)  — patient-document citations (lab PDFs / intake
 *                           forms) routed through the document inbox.
 *                           Color: --cite-doc / --cite-doc-ink.
 *
 * Future polish (#34 and beyond) can replace this string-table with a
 * registry that resolves a chart row back to its source code/value, but
 * for the v1 dock we only need a kind + a short pill label.
 *
 * Anything that doesn't match a known prefix falls back to a generic
 * clinical "Source" chip — better than crashing the chip row when the
 * agent emits a shape we don't recognize yet.
 */

export type CitationChipKind = 'clinical' | 'document';

export interface CitationChip {
  readonly kind: CitationChipKind;
  readonly label: string;
}

/**
 * Resolve a single citation_id into the chip metadata used by the chip
 * row renderer. Pure — no side effects, no I/O. Safe to call inline in
 * render.
 */
export function resolveCitationChip(citationId: string): CitationChip {
  // doc: → amber document chip. Two known sub-kinds today (lab PDFs and
  // intake forms). Anything else under the doc: prefix falls through to
  // a generic "Document" pill so we don't surface internal sub-keys.
  if (citationId.startsWith('doc:lab-')) {
    return { kind: 'document', label: 'Lab Doc' };
  }
  if (citationId.startsWith('doc:intake-')) {
    return { kind: 'document', label: 'Intake' };
  }
  if (citationId.startsWith('doc:')) {
    return { kind: 'document', label: 'Document' };
  }

  // rule: → blue guideline chip. We deliberately don't surface the rule
  // category in the label here; it's noise for clinicians who want a
  // glanceable "this came from a guideline" cue, not the rule's
  // internal classification.
  if (citationId.startsWith('rule:')) {
    return { kind: 'clinical', label: 'Guideline' };
  }

  // tool: → chart-row citation. Map the known tool names to short
  // human labels. The set of tools is small and stable (see the
  // AgentForge tool registry); anything new defaults to "Chart" so a
  // freshly-added tool ships a usable chip the day it lands rather
  // than waiting for the SPA to catch up.
  if (citationId.startsWith('tool:medication_list:') || citationId.startsWith('tool:get_medications:')) {
    return { kind: 'clinical', label: 'Meds' };
  }
  if (citationId.startsWith('tool:lab_results:') || citationId.startsWith('tool:get_recent_labs:')) {
    return { kind: 'clinical', label: 'Labs' };
  }
  if (citationId.startsWith('tool:allergies:') || citationId.startsWith('tool:get_allergies:')) {
    return { kind: 'clinical', label: 'Allergies' };
  }
  if (citationId.startsWith('tool:problems:') || citationId.startsWith('tool:get_active_problems:')) {
    return { kind: 'clinical', label: 'Problems' };
  }
  if (citationId.startsWith('tool:problem_list:')) {
    return { kind: 'clinical', label: 'Problems' };
  }
  if (citationId.startsWith('tool:get_vitals:')) {
    return { kind: 'clinical', label: 'Vitals' };
  }
  if (citationId.startsWith('tool:care_team:')) {
    return { kind: 'clinical', label: 'Care Team' };
  }
  if (citationId.startsWith('tool:prescriptions:')) {
    return { kind: 'clinical', label: 'Rx' };
  }
  if (citationId.startsWith('tool:')) {
    return { kind: 'clinical', label: 'Chart' };
  }

  // Anything else (malformed id, unknown prefix) — surface as a generic
  // clinical "Source" chip. Hard-failing the whole chip row would punish
  // users for a single bad id, and the underlying answer is already on
  // screen so we lose nothing by best-efforting the chip.
  return { kind: 'clinical', label: 'Source' };
}

/**
 * Deduplicate a list of citation_ids preserving first-seen order. The
 * dock renders one row of chips per answer turn, taking the union of
 * `claim.citation_ids` across every claim in the answer. Multiple claims
 * commonly cite the same row — we want to render that row once.
 */
export function dedupeCitationIds(ids: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push(id);
  }
  return out;
}
