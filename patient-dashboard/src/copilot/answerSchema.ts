/**
 * Client-side mirror of the AgentForge `Answer` schema.
 *
 * The canonical schema lives in `agent/src/schemas/AnswerSchema.ts`. We
 * deliberately ship a tolerant Zod copy here rather than importing the
 * server one — the SPA bundles independently from the Node sidecar and
 * MUST NOT take a build-time dep on `agent/`.
 *
 * SSE events (see `agent/src/routes/chat.ts`):
 *
 *   conversation     → { conversation_id, … }
 *   evidence_catalog → { entries: EvidenceCatalogEntry[] }
 *   summary          → { text }
 *   claim            → { text, citation_ids[], evidence_refs?, severity, section? }
 *   confidence       → { value: 'high'|'medium'|'low' }
 *   done             → {}
 *   error            → { reason }
 */

import { z } from 'zod';

export const ChatSeveritySchema = z.enum(['info', 'attention', 'urgent']);
export type ChatSeverity = z.infer<typeof ChatSeveritySchema>;

export const ChatConfidenceSchema = z.enum(['high', 'medium', 'low']);
export type ChatConfidence = z.infer<typeof ChatConfidenceSchema>;

const EvidenceFacetSchema = z.enum(['clinical', 'document']);

const ChartRowEvidenceWireSchema = z.object({
  kind: z.literal('chart_row'),
  id: z.string(),
  label: z.string(),
  facet: EvidenceFacetSchema,
  legacy_pointer: z.string(),
  tool: z.string(),
  row_index: z.number(),
  document_hint: z.string().nullable().optional(),
});

const GuidelineEvidenceWireSchema = z.object({
  kind: z.literal('guideline'),
  id: z.string(),
  label: z.string(),
  facet: EvidenceFacetSchema,
  legacy_pointer: z.string(),
  corpus: z.string(),
  section_id: z.string(),
  chunk_id: z.string().nullable().optional(),
});

const PatientDocumentEvidenceWireSchema = z.object({
  kind: z.literal('patient_document'),
  id: z.string(),
  label: z.string(),
  facet: EvidenceFacetSchema,
  legacy_pointer: z.string(),
  doc_kind: z.enum(['lab', 'intake']),
  document_id: z.number(),
  extraction_id: z.string().nullable().optional(),
});

export const EvidenceCatalogEntryWireSchema = z.discriminatedUnion('kind', [
  ChartRowEvidenceWireSchema,
  GuidelineEvidenceWireSchema,
  PatientDocumentEvidenceWireSchema,
]);
export type EvidenceCatalogEntryWire = z.infer<typeof EvidenceCatalogEntryWireSchema>;

export const EvidenceCatalogEventSchema = z.object({
  entries: z.array(z.unknown()),
});
export type EvidenceCatalogEvent = z.infer<typeof EvidenceCatalogEventSchema>;

/**
 * Pixel-space bbox emitted on a claim event for `patient_document`
 * citations. Coordinates are in the original VLM/OCR rendered-image
 * space; the chip click handler scales them to the modal's actual
 * rendered page size using `image_w` / `image_h` as the reference frame.
 */
export const CitationBboxSchema = z.object({
  page: z.number().int().nonnegative(),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  image_w: z.number().positive(),
  image_h: z.number().positive(),
});
export type CitationBbox = z.infer<typeof CitationBboxSchema>;

export const ClaimEventSchema = z.object({
  text: z.string().min(1),
  citation_ids: z.array(z.string()).min(1),
  evidence_refs: z.array(z.string()).optional(),
  finding_confidence: ChatConfidenceSchema.optional(),
  uncertainty_reason: z.string().optional(),
  severity: ChatSeveritySchema,
  /** Previsit mode only — which dashboard section this claim belongs to. */
  section: z.string().optional(),
  /**
   * Per-pointer bbox map for the patient_document chips on this claim.
   * Keyed by the legacy citation_id (e.g. `doc:lab-2`). Pointers without
   * a bbox (chart-row attribution, etc.) are absent.
   */
  citation_bboxes: z.record(z.string(), CitationBboxSchema).optional(),
});
export type ClaimEvent = z.infer<typeof ClaimEventSchema>;

export const ConversationEventSchema = z.object({
  conversation_id: z.string(),
  llm_driven: z.boolean().optional(),
  anchor: z.string().nullable().optional(),
  prior_message_count: z.number().int().nonnegative().optional(),
});
export type ConversationEvent = z.infer<typeof ConversationEventSchema>;

export const SummaryEventSchema = z.object({
  text: z.string(),
});
export type SummaryEvent = z.infer<typeof SummaryEventSchema>;

export const ConflictEventSchema = z.object({
  type: z.string().min(1),
  severity: ChatSeveritySchema,
  message: z.string().min(1),
  evidence_refs: z.array(z.string()).optional(),
});
export type ConflictEvent = z.infer<typeof ConflictEventSchema>;

export const DataGapEventSchema = z.object({
  id: z.string().optional(),
  message: z.string().min(1),
  severity: ChatSeveritySchema,
  blocks: z.array(z.string()).optional(),
});
export type DataGapEvent = z.infer<typeof DataGapEventSchema>;

export const AssumptionEventSchema = z.object({
  id: z.string().optional(),
  message: z.string().min(1),
});
export type AssumptionEvent = z.infer<typeof AssumptionEventSchema>;

export const ConfidenceEventSchema = z.object({
  value: ChatConfidenceSchema,
});
export type ConfidenceEvent = z.infer<typeof ConfidenceEventSchema>;

/**
 * Previsit-mode header frame emitted before the claims of each section.
 * Carries the human-readable section label and an empty-state placeholder
 * for sections with no claims. The SPA persists the `key → label` mapping
 * so AnswerBubble can render claims under polished labels (e.g.
 * "Action Items") instead of the raw section key (e.g. "actionItems").
 */
export const SectionEventSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  empty: z.boolean().optional(),
  empty_message: z.string().optional(),
});
export type SectionEvent = z.infer<typeof SectionEventSchema>;

export const ErrorEventSchema = z.object({
  reason: z.string(),
});
export type ErrorEvent = z.infer<typeof ErrorEventSchema>;

export type EvidenceCatalogIndex = Readonly<Record<string, EvidenceCatalogEntryWire>>;

/**
 * In-progress / final Answer state for the dock.
 */
export interface ChatAnswer {
  readonly summary: string;
  readonly claims: ReadonlyArray<ClaimEvent>;
  readonly conflicts: ReadonlyArray<ConflictEvent>;
  readonly data_gaps: ReadonlyArray<DataGapEvent>;
  readonly assumptions: ReadonlyArray<AssumptionEvent>;
  readonly confidence: ChatConfidence;
  /** Populated after `evidence_catalog` SSE — keyed by `ev_n` ids. */
  readonly evidence_catalog: EvidenceCatalogIndex;
  /**
   * Previsit `section` frames register section keys to their human
   * labels here. AnswerBubble looks claims' `section` key up in this
   * map; falls back to the raw key when the agent hasn't emitted a
   * label (followup mode, or future sections with no header frame).
   */
  readonly section_labels: Readonly<Record<string, string>>;
}

/** Empty answer — the starting point for a new streaming turn. */
export function emptyAnswer(): ChatAnswer {
  return {
    summary: '',
    claims: [],
    conflicts: [],
    data_gaps: [],
    assumptions: [],
    confidence: 'medium',
    evidence_catalog: {},
    section_labels: {},
  };
}

function indexEvidenceEntries(entries: readonly unknown[]): EvidenceCatalogIndex {
  const out: Record<string, EvidenceCatalogEntryWire> = {};
  for (const raw of entries) {
    const parsed = EvidenceCatalogEntryWireSchema.safeParse(raw);
    if (parsed.success) {
      out[parsed.data.id] = parsed.data;
    }
  }
  return out;
}

/**
 * Apply a parsed SSE event to an in-flight Answer, returning a NEW
 * Answer (immutable update).
 */
export function applyEvent(
  answer: ChatAnswer,
  event: ParsedEvent,
): ChatAnswer {
  switch (event.kind) {
    case 'summary':
      return { ...answer, summary: event.payload.text };
    case 'evidence_catalog':
      return {
        ...answer,
        evidence_catalog: indexEvidenceEntries(event.payload.entries),
      };
    case 'claim':
      return { ...answer, claims: [...answer.claims, event.payload] };
    case 'section':
      return {
        ...answer,
        section_labels: {
          ...answer.section_labels,
          [event.payload.key]: event.payload.label,
        },
      };
    case 'conflict':
      return { ...answer, conflicts: [...answer.conflicts, event.payload] };
    case 'data_gap':
      return { ...answer, data_gaps: [...answer.data_gaps, event.payload] };
    case 'assumption':
      return { ...answer, assumptions: [...answer.assumptions, event.payload] };
    case 'confidence':
      return { ...answer, confidence: event.payload.value };
    case 'conversation':
    case 'done':
    case 'error':
    case 'unknown':
      return answer;
  }
}

export type ParsedEvent =
  | { kind: 'conversation'; payload: ConversationEvent }
  | { kind: 'evidence_catalog'; payload: EvidenceCatalogEvent }
  | { kind: 'summary'; payload: SummaryEvent }
  | { kind: 'claim'; payload: ClaimEvent }
  | { kind: 'section'; payload: SectionEvent }
  | { kind: 'conflict'; payload: ConflictEvent }
  | { kind: 'data_gap'; payload: DataGapEvent }
  | { kind: 'assumption'; payload: AssumptionEvent }
  | { kind: 'confidence'; payload: ConfidenceEvent }
  | { kind: 'done'; payload: Record<string, unknown> }
  | { kind: 'error'; payload: ErrorEvent }
  | { kind: 'unknown'; eventName: string; rawData: string };

export function parseSseEvent(
  eventName: string,
  rawData: string,
): ParsedEvent | null {
  let data: unknown;
  try {
    data = JSON.parse(rawData);
  } catch {
    return null;
  }

  switch (eventName) {
    case 'conversation': {
      const parsed = ConversationEventSchema.safeParse(data);
      if (!parsed.success) return null;
      return { kind: 'conversation', payload: parsed.data };
    }
    case 'evidence_catalog': {
      const parsed = EvidenceCatalogEventSchema.safeParse(data);
      if (!parsed.success) return null;
      return { kind: 'evidence_catalog', payload: parsed.data };
    }
    case 'summary': {
      const parsed = SummaryEventSchema.safeParse(data);
      if (!parsed.success) return null;
      return { kind: 'summary', payload: parsed.data };
    }
    case 'claim': {
      const parsed = ClaimEventSchema.safeParse(data);
      if (!parsed.success) return null;
      return { kind: 'claim', payload: parsed.data };
    }
    case 'section': {
      const parsed = SectionEventSchema.safeParse(data);
      if (!parsed.success) return null;
      return { kind: 'section', payload: parsed.data };
    }
    case 'conflict': {
      const parsed = ConflictEventSchema.safeParse(data);
      if (!parsed.success) return null;
      return { kind: 'conflict', payload: parsed.data };
    }
    case 'data_gap': {
      const parsed = DataGapEventSchema.safeParse(data);
      if (!parsed.success) return null;
      return { kind: 'data_gap', payload: parsed.data };
    }
    case 'assumption': {
      const parsed = AssumptionEventSchema.safeParse(data);
      if (!parsed.success) return null;
      return { kind: 'assumption', payload: parsed.data };
    }
    case 'confidence': {
      const parsed = ConfidenceEventSchema.safeParse(data);
      if (!parsed.success) return null;
      return { kind: 'confidence', payload: parsed.data };
    }
    case 'done':
      return {
        kind: 'done',
        payload: typeof data === 'object' && data !== null
          ? (data as Record<string, unknown>)
          : {},
      };
    case 'error': {
      const parsed = ErrorEventSchema.safeParse(data);
      if (!parsed.success) {
        return { kind: 'error', payload: { reason: 'agent_internal_error' } };
      }
      return { kind: 'error', payload: parsed.data };
    }
    default:
      return { kind: 'unknown', eventName, rawData };
  }
}
