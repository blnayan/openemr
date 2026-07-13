/**
 * Evidence catalog materialization — turns Answer.citation_ids (+ optional rich
 * Citation payloads) into a stable per-turn catalog for SSE and transcripts.
 *
 * @package OpenEMR
 * @license https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

import type { Answer, Claim, Citation } from '../schemas/AnswerSchema.js';
import type { ToolResult, ToolRow } from '../tools/types.js';

export type EvidenceCatalogEntryWire =
  | {
      kind: 'chart_row';
      id: string;
      label: string;
      facet: 'clinical';
      legacy_pointer: string;
      tool: string;
      row_index: number;
      document_hint: string | null;
    }
  | {
      kind: 'guideline';
      id: string;
      label: string;
      facet: 'clinical';
      legacy_pointer: string;
      corpus: string;
      section_id: string;
      chunk_id: string | null;
    }
  | {
      kind: 'patient_document';
      id: string;
      label: string;
      facet: 'document';
      legacy_pointer: string;
      doc_kind: 'lab' | 'intake';
      document_id: number;
      extraction_id: string | null;
    };

export interface MaterializedEvidenceCatalog {
  readonly entries: readonly EvidenceCatalogEntryWire[];
  /** Every citation_id (`legacy_pointer`) → catalog id (`ev_1`, …). */
  readonly pointerToEvidenceId: ReadonlyMap<string, string>;
}

export function evidenceRefsForCitationIds(
  citationIds: readonly string[],
  pointerToEvidenceId: ReadonlyMap<string, string>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of citationIds) {
    const ev = pointerToEvidenceId.get(p);
    if (ev === undefined || seen.has(ev)) continue;
    seen.add(ev);
    out.push(ev);
  }
  return out;
}

const TOOL_RE = /^tool:([a-z_]+):row-(\d+)$/;
const RULE_RE = /^rule:([a-z]+):(.+)$/;
const DOC_LAB_RE = /^doc:lab-(\d+)$/;
const DOC_INTAKE_RE = /^doc:intake-(\d+)$/;

/** Short tool → section label for chart_row fallbacks */
const TOOL_LABEL: Record<string, string> = {
  get_medications: 'Meds',
  get_recent_labs: 'Labs',
  get_allergies: 'Allergies',
  get_active_problems: 'Problems',
  get_patient_summary: 'Demographics',
  get_vitals: 'Vitals',
  get_recent_encounters: 'Encounters',
  check_drug_interactions: 'DDI',
};

function buildRowByCitationId(toolResults: readonly ToolResult[]): Map<string, ToolRow> {
  const m = new Map<string, ToolRow>();
  for (const tr of toolResults) {
    if (!tr.ok) continue;
    for (const row of tr.rows) {
      m.set(row.id, row);
    }
  }
  return m;
}

function documentHintFromRow(row: ToolRow): string | null {
  const src = row['source'];
  if (!src || typeof src !== 'object' || Array.isArray(src)) return null;
  const kind = (src as { kind?: unknown }).kind;
  if (kind !== 'document') return null;
  const name = (src as { document_name?: unknown }).document_name;
  if (typeof name === 'string' && name.trim() !== '') {
    const n = name.trim();
    return n.length > 48 ? `${n.slice(0, 47)}…` : n;
  }
  const id = (src as { document_id?: unknown }).document_id;
  if (typeof id === 'number' && id > 0) return `#${id}`;
  return null;
}

function summarizeChartRow(tool: string, rowIndex: number, row: ToolRow | undefined): string {
  if (!row) {
    const ln = TOOL_LABEL[tool] ?? 'Chart';
    return `${ln} · row ${rowIndex}`;
  }
  switch (tool) {
    case 'get_medications': {
      const drug = row['drug_name'];
      const bits: string[] = [];
      if (typeof drug === 'string' && drug.trim() !== '') bits.push(drug.trim());
      const dosage = row['dosage'];
      if (typeof dosage === 'string' && dosage.trim() !== '') bits.push(dosage.trim());
      return bits.length > 0 ? `Meds · ${bits.join(' · ')}` : `Meds · row ${rowIndex}`;
    }
    case 'get_recent_labs': {
      const name = row['name'];
      const val = row['value'];
      const unit = row['unit'];
      const nameStr = typeof name === 'string' && name.trim() !== '' ? name.trim() : 'Lab';
      if (val !== null && val !== undefined && String(val).trim() !== '') {
        const u = typeof unit === 'string' && unit.trim() !== '' ? ` ${unit.trim()}` : '';
        return `Labs · ${nameStr}: ${String(val)}${u}`;
      }
      return `Labs · ${nameStr}`;
    }
    case 'get_allergies': {
      const a = row['allergen'];
      return typeof a === 'string' && a.trim() !== ''
        ? `Allergies · ${a.trim()}`
        : `Allergies · row ${rowIndex}`;
    }
    case 'get_active_problems':
    case 'get_problems':
    case 'get_problem_list': {
      const c = row['condition'] ?? row['problem'] ?? row['description'] ?? row['code_text'];
      return typeof c === 'string' && c.trim() !== ''
        ? `Problems · ${c.trim()}`
        : `Problems · row ${rowIndex}`;
    }
    case 'get_vitals': {
      const code = row['name'] ?? row['code_display'] ?? row['code'];
      const v = row['value'] ?? row['systolic'];
      const u = row['unit'] ?? '';
      const codeStr = typeof code === 'string' && code.trim() !== '' ? code.trim() : 'Vitals';
      if (v !== null && v !== undefined && String(v).trim() !== '') {
        const um = typeof u === 'string' && u.trim() !== '' ? ` ${u.trim()}` : '';
        return `Vitals · ${codeStr}: ${String(v)}${um}`;
      }
      return `Vitals · ${codeStr}`;
    }
    case 'get_recent_encounters': {
      const d = row['date'] ?? row['period_start'];
      const type = row['type'] ?? row['class_display'];
      if (typeof type === 'string' && type.trim() !== '')
        return `Encounter · ${type.trim()}`;
      if (typeof d === 'string' && d.trim() !== '') return `Encounter · ${d.trim().slice(0, 16)}`;
      return `Encounter · row ${rowIndex}`;
    }
    case 'get_patient_summary': {
      const name =
        row['name'] ?? row['patient_name'];
      return typeof name === 'string' && name.trim() !== ''
        ? `Patient · ${name.trim()}`
        : `Demographics · row ${rowIndex}`;
    }
    case 'check_drug_interactions': {
      const desc = row['description'];
      const sev = row['severity'];
      const d =
        typeof desc === 'string' && desc.trim() !== ''
          ? (desc.trim().length > 56 ? `${desc.trim().slice(0, 55)}…` : desc.trim())
          : 'Interaction';
      const s = typeof sev === 'string' ? sev : '';
      return s !== '' ? `DDI · ${s} · ${d}` : `DDI · ${d}`;
    }
    default: {
      const ln = TOOL_LABEL[tool] ?? tool.replace(/^get_/i, '');
      return `${ln} · row ${rowIndex}`;
    }
  }
}

function enrichGuidelineForPointer(pointer: string, claims: readonly Claim[]): {
  corpus: string;
  section_id: string;
  chunk_id: string | null;
  label: string;
} | null {
  const ruleMatch = pointer.match(RULE_RE);
  const slug = ruleMatch ? ruleMatch[2] : '';

  for (const claim of claims) {
    if (!claim.citation_ids.includes(pointer)) continue;
    const rich = claim.citations?.filter((c): c is Extract<Citation, { type: 'guideline' }> => c.type === 'guideline') ?? [];
    for (const g of rich) {
      if (!slug || g.section_id === slug || pointer.endsWith(`:${g.section_id}`)) {
        const corpusShort = g.source.length > 56 ? `${g.source.slice(0, 55)}…` : g.source;
        return {
          corpus: g.source,
          section_id: g.section_id,
          chunk_id: g.chunk_id ?? null,
          label: `${corpusShort} · §${g.section_id}`,
        };
      }
    }
  }

  return null;
}

/**
 * Sidecar lookup map: extraction_id (the `agentforge_document_extractions.id`)
 * → the OpenEMR `documents.id` and `documents.name` for the source PDF.
 * The synthesizer uses extraction_ids as the suffix on `doc:lab-<X>` /
 * `doc:intake-<X>` pointers (see Synthesizer.ts:218-220), so the catalog
 * can't infer the real `documents.id` from the pointer alone — without
 * this map we mistake the extraction_id for a documents.id and the
 * tool-row scan misses, producing the generic "Lab document · …<id>"
 * fallback.
 */
export interface SidecarDocResolver {
  readonly lab: { extractionId: string; documentId: number | null; documentName: string | null } | null;
  readonly intake: { extractionId: string; documentId: number | null; documentName: string | null } | null;
}

function enrichPatientDocForPointer(
  pointer: string,
  claims: readonly Claim[],
  docKind: 'lab' | 'intake',
  pointerSuffix: number,
  rowById: Map<string, ToolRow>,
  sidecar: SidecarDocResolver | null,
): { extraction_id: string | null; document_id: number; label: string } {
  let extraction_id: string | null = null;
  for (const claim of claims) {
    if (!claim.citation_ids.includes(pointer)) continue;
    const rich =
      claim.citations?.filter(
        (c): c is Extract<Citation, { type: 'patient_document' }> => c.type === 'patient_document',
      ) ?? [];
    for (const p of rich) {
      extraction_id = p.extraction_id;
      break;
    }
    if (extraction_id !== null) break;
  }

  // Two namespaces map to `doc:<kind>-<X>`:
  //   1. the sidecar `extraction_id` (used when the synthesizer cites a
  //      sidecar lab/intake fact directly), and
  //   2. the OpenEMR `documents.id` (used as a secondary attribution on
  //      clinical-tool rows whose `source.kind === "document"`).
  // We resolve both via the sidecar map first (case 1), then fall back
  // to the tool-row scan (case 2). This keeps the chip label honest in
  // both cases.
  let docName: string | null = null;
  let resolvedDocId: number = pointerSuffix;
  const sideMatch = sidecar
    ? (docKind === 'lab' ? sidecar.lab : sidecar.intake)
    : null;
  if (
    sideMatch
    && sideMatch.documentId !== null
    && (
      // Suffix is the sidecar extraction_id we know about, OR
      String(pointerSuffix) === sideMatch.extractionId
      // Suffix already IS the real documents.id we know about.
      || pointerSuffix === sideMatch.documentId
    )
  ) {
    resolvedDocId = sideMatch.documentId;
    docName = sideMatch.documentName;
  } else {
    // Fall back to the original tool-row scan (clinical-tool-row case).
    for (const row of rowById.values()) {
      const src = row['source'];
      if (!src || typeof src !== 'object') continue;
      if ((src as { kind?: unknown }).kind !== 'document') continue;
      const did = (src as { document_id?: unknown }).document_id;
      if (did !== pointerSuffix) continue;
      const nm = (src as { document_name?: unknown }).document_name;
      if (typeof nm === 'string' && nm.trim() !== '') {
        docName = nm.trim();
        resolvedDocId = pointerSuffix;
        break;
      }
    }
  }

  const docHintBase = docName ?? (docKind === 'lab' ? 'Lab document' : 'Intake form');
  const docHint = docHintBase.length > 40 ? `${docHintBase.slice(0, 39)}…` : docHintBase;
  const prefix = docKind === 'lab' ? 'Lab' : 'Intake';
  let label = `${prefix} · ${docHint} · #${resolvedDocId}`;
  if (label.length > 120) label = `${label.slice(0, 119)}…`;

  return { extraction_id, document_id: resolvedDocId, label };
}

function makeEntryForPointer(
  pointer: string,
  evId: string,
  rowsByCitation: Map<string, ToolRow>,
  claims: readonly Claim[],
  sidecar: SidecarDocResolver | null,
): EvidenceCatalogEntryWire {
  let toolMatch = pointer.match(TOOL_RE);
  if (toolMatch) {
    const tool = toolMatch[1] ?? '';
    const rowIdx = Number(toolMatch[2] ?? -1);
    const row = rowsByCitation.get(pointer);
    const label = summarizeChartRow(tool, Number.isFinite(rowIdx) ? rowIdx : 0, row);
    return {
      kind: 'chart_row',
      id: evId,
      label,
      facet: 'clinical',
      legacy_pointer: pointer,
      tool,
      row_index: Number.isFinite(rowIdx) ? rowIdx : 0,
      document_hint: row ? documentHintFromRow(row) : null,
    };
  }

  const ruleMatch = pointer.match(RULE_RE);
  if (ruleMatch) {
    const category = ruleMatch[1] ?? 'rule';
    const slug = ruleMatch[2] ?? '';
    const enr = enrichGuidelineForPointer(pointer, claims);
    if (enr) {
      return {
        kind: 'guideline',
        id: evId,
        label: enr.label,
        facet: 'clinical',
        legacy_pointer: pointer,
        corpus: enr.corpus,
        section_id: enr.section_id,
        chunk_id: enr.chunk_id,
      };
    }
    return {
      kind: 'guideline',
      id: evId,
      label: category === 'ddi' ? `Interaction check · ${slug}` : `Guideline · §${slug}`,
      facet: 'clinical',
      legacy_pointer: pointer,
      corpus: category.toUpperCase(),
      section_id: slug,
      chunk_id: null,
    };
  }

  let m = pointer.match(DOC_LAB_RE);
  if (m) {
    const pointerSuffix = Number(m[1] ?? '');
    const { extraction_id, document_id, label } = enrichPatientDocForPointer(
      pointer,
      claims,
      'lab',
      pointerSuffix,
      rowsByCitation,
      sidecar,
    );
    return {
      kind: 'patient_document',
      id: evId,
      label,
      facet: 'document',
      legacy_pointer: pointer,
      doc_kind: 'lab',
      document_id,
      extraction_id,
    };
  }

  m = pointer.match(DOC_INTAKE_RE);
  if (m) {
    const pointerSuffix = Number(m[1] ?? '');
    const { extraction_id, document_id, label } = enrichPatientDocForPointer(
      pointer,
      claims,
      'intake',
      pointerSuffix,
      rowsByCitation,
      sidecar,
    );
    return {
      kind: 'patient_document',
      id: evId,
      label,
      facet: 'document',
      legacy_pointer: pointer,
      doc_kind: 'intake',
      document_id,
      extraction_id,
    };
  }

  // Should not reach — AnswerSchema restricts pointers; tolerate unknowns.
  return {
    kind: 'chart_row',
    id: evId,
    label: pointer,
    facet: 'clinical',
    legacy_pointer: pointer,
    tool: 'unknown',
    row_index: 0,
    document_hint: null,
  };
}

/**
 * Stable catalog: first-seen citation_id order walks claims in Answer order,
 * ref ids are ev_1, ev_2, … Claim index maps cite each claim's citation_ids.
 *
 * Pass `sidecar` to resolve `doc:lab-<extraction_id>` /
 * `doc:intake-<extraction_id>` pointers to the underlying `documents.id`
 * + `documents.name`. Without it, the catalog can only render those
 * pointers as a generic "Lab document · #<extraction_id>" — which mis-
 * labels the chip because the suffix is the sidecar extraction_id, not
 * the OpenEMR documents.id. Caller threads this through from the lab
 * + intake worker outputs (see chat.ts call sites).
 */
export function materializeEvidenceCatalogForAnswer(
  answer: Answer,
  toolResults: readonly ToolResult[] = [],
  sidecar: SidecarDocResolver | null = null,
): MaterializedEvidenceCatalog {
  const claims = answer.claims;
  const rowsByCitation = buildRowByCitationId(toolResults);

  const pointerToEvId = new Map<string, string>();
  const entries: EvidenceCatalogEntryWire[] = [];
  let next = 1;

  for (const claim of claims) {
    for (const pointer of claim.citation_ids) {
      if (!pointerToEvId.has(pointer)) {
        const evId = `ev_${next}`;
        next += 1;
        pointerToEvId.set(pointer, evId);
        entries.push(makeEntryForPointer(pointer, evId, rowsByCitation, claims, sidecar));
      }
    }
  }

  return {
    entries,
    pointerToEvidenceId: pointerToEvId,
  };
}

