/**
 * BboxLocator — anchors VLM-extracted text against Tesseract OCR
 * output to produce pixel-accurate bounding boxes for the document
 * inbox overlay viewer.
 *
 * Two information sources, with a clear preference order:
 *
 *   1. BboxPlan (LLM-produced, optional). The selector produces a map
 *      from entity_id → OCR line (and optionally word) indices. The
 *      locator unions the named bboxes — no scoring, no guessing.
 *      This is the primary path because the LLM can recognize when
 *      Tesseract split a single visual row across multiple OCR lines
 *      (long unit columns, value-on-next-line layouts) and instruct
 *      the locator to union them.
 *
 *   2. Mechanical token-overlap fallback. When no plan is supplied,
 *      or the plan omits an entity, or the plan's indices fall out of
 *      range, the locator scores OCR lines by token overlap with the
 *      entity's text fields and picks the best match. Matches the
 *      pre-LLM behaviour exactly.
 *
 * Two anchoring modes:
 *
 *   TIGHT — names and demographic values. Plan-driven path uses
 *           word_indices to hug just the value; fallback path matches
 *           a contiguous run of words on a single line.
 *
 *   ROW   — table-row entities (lab results, medications, allergies,
 *           family-history rows, chief concern). Plan-driven path
 *           unions every word across the named line indices (so a
 *           wrapped row produces a single tall bbox); fallback path
 *           returns the highest-scoring single line.
 *
 * Trim-undo: image uploads are trimmed before being shown to OCR, but
 * the browser displays the original (untrimmed) bytes. So OCR-frame
 * bboxes are translated back into the original frame here. PDF pages
 * don't trim (no-op).
 *
 * No-match policy: when neither path can place an entity, the locator
 * emits a zero-area bbox at (0, 0) for ROW entities and null for the
 * patient name (whose schema allows null). The overlay viewer
 * short-circuits zero-area / null bboxes by drawing nothing, so the
 * user sees no false highlight rather than a wrong one.
 */

import type { Bbox } from '../schemas/Bbox.js';
import type { BboxPlan, BboxPlanEntry } from './BboxPlan.js';
import type {
  FamilyHistoryEntry,
  IntakeAllergy,
  IntakeForm,
  IntakeMedication,
} from '../schemas/IntakeFormSchema.js';
import type { LabPdf, LabResult } from '../schemas/LabPdfSchema.js';
import type { OcrLine, OcrPage, OcrWord } from './OcrService.js';
import type { RenderedPage } from './types.js';
import type { BboxSelectorEntity } from './LlmBboxSelector.js';
import type { VlmIntakeForm } from '../schemas/VlmIntakeFormSchema.js';
import type { VlmLabPdf } from '../schemas/VlmLabPdfSchema.js';

type FrameInfo = {
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly originalWidth: number;
  readonly originalHeight: number;
  readonly trimOffsetLeft: number;
  readonly trimOffsetTop: number;
};

const ZERO_BBOX: Bbox = {
  page: 0, x: 0, y: 0, w: 0, h: 0, image_w: 0, image_h: 0,
};

export class BboxLocator {
  private readonly framesByPage: Map<number, FrameInfo>;
  private readonly planByEntityId: Map<string, BboxPlanEntry>;

  constructor(
    private readonly ocrPages: ReadonlyArray<OcrPage>,
    pages: ReadonlyArray<RenderedPage>,
    plan: BboxPlan | null = null,
  ) {
    this.framesByPage = new Map();
    for (const p of pages) {
      this.framesByPage.set(p.page, {
        imageWidth: p.imageWidth,
        imageHeight: p.imageHeight,
        originalWidth: p.originalWidth,
        originalHeight: p.originalHeight,
        trimOffsetLeft: p.trimOffsetLeft,
        trimOffsetTop: p.trimOffsetTop,
      });
    }
    this.planByEntityId = new Map();
    if (plan !== null) {
      for (const entry of plan.entries) this.planByEntityId.set(entry.entity_id, entry);
    }
  }

  // ------------------------------------------------------------------
  // Lab PDF
  // ------------------------------------------------------------------

  locateLabPdf(vlm: VlmLabPdf): LabPdf {
    const patient = vlm.patient_on_document
      ? {
        name: vlm.patient_on_document.name,
        bbox: vlm.patient_on_document.name !== null
          ? this.locatePlanned('patient_on_document', 'tight')
            ?? this.locateTight(vlm.patient_on_document.name)
          : null,
      }
      : null;

    const results: LabResult[] = vlm.results.map((row, i) => this.locateLabResultRow(i, row));

    return {
      doc_type: 'lab_pdf',
      schema_version: vlm.schema_version,
      performing_lab: vlm.performing_lab,
      ordering_provider: vlm.ordering_provider,
      collection_date_default: vlm.collection_date_default,
      patient_on_document: patient,
      results,
      source_citation: vlm.source_citation,
    } as LabPdf;
  }

  private locateLabResultRow(idx: number, row: VlmLabPdf['results'][number]): LabResult {
    const anchors = compact([
      row.test_name,
      row.display_value,
      row.unit,
      row.loinc_code,
      row.reference_range.raw_text,
    ]);
    return {
      ...row,
      bbox: this.locatePlanned(`results[${idx}]`, 'row')
        ?? this.locateRow(anchors)
        ?? ZERO_BBOX,
    } as LabResult;
  }

  // ------------------------------------------------------------------
  // Intake form
  // ------------------------------------------------------------------

  locateIntakeForm(vlm: VlmIntakeForm): IntakeForm {
    const bbox_per_field: Record<string, Bbox> = {};
    for (const [key, value] of Object.entries(vlm.demographics.field_values)) {
      const located = this.locatePlanned(`demographics.field_values.${key}`, 'tight')
        ?? this.locateTight(value);
      if (located !== null) bbox_per_field[key] = located;
    }

    const chief = vlm.chief_concern
      ? {
        text: vlm.chief_concern.text,
        bbox: this.locatePlanned('chief_concern', 'row')
          ?? this.locateRow([vlm.chief_concern.text])
          ?? ZERO_BBOX,
      }
      : null;

    const current_medications: IntakeMedication[] = vlm.current_medications.map((m, i) => ({
      ...m,
      bbox: this.locatePlanned(`current_medications[${i}]`, 'row')
        ?? this.locateRow(compact([m.name, m.dose, m.frequency, m.route]))
        ?? ZERO_BBOX,
    }));

    const allergies: IntakeAllergy[] = vlm.allergies.map((a, i) => ({
      ...a,
      bbox: this.locatePlanned(`allergies[${i}]`, 'row')
        ?? this.locateRow(compact([a.substance, a.reaction]))
        ?? ZERO_BBOX,
    }));

    const family_history: FamilyHistoryEntry[] = vlm.family_history.map((f, i) => ({
      ...f,
      bbox: this.locatePlanned(`family_history[${i}]`, 'row')
        ?? this.locateRow(compact([f.relation, ...f.conditions]))
        ?? ZERO_BBOX,
    }));

    return {
      doc_type: 'intake_form',
      schema_version: vlm.schema_version,
      demographics: {
        name: vlm.demographics.name,
        dob: vlm.demographics.dob,
        sex: vlm.demographics.sex,
        bbox_per_field,
      },
      chief_concern: chief,
      current_medications,
      allergies,
      family_history,
      source_citation: vlm.source_citation,
    } as IntakeForm;
  }

  // ------------------------------------------------------------------
  // Plan-driven path (preferred)
  // ------------------------------------------------------------------

  /**
   * Resolve an entity via the LLM-produced plan, if one was supplied
   * and contains a valid entry for this entity. Returns null when:
   *   - no plan was supplied
   *   - the plan omits this entity
   *   - the plan names a page or line index that doesn't exist
   * The caller should then fall back to the mechanical heuristic.
   */
  private locatePlanned(entityId: string, mode: 'tight' | 'row'): Bbox | null {
    const entry = this.planByEntityId.get(entityId);
    if (entry === undefined) return null;
    const ocr = this.ocrPages.find((p) => p.page === entry.page);
    if (ocr === undefined) return null;
    const lines: OcrLine[] = [];
    for (const idx of entry.line_indices) {
      const line = ocr.lines[idx];
      if (line === undefined) return null;
      lines.push(line);
    }
    if (lines.length === 0) return null;

    if (mode === 'tight' && entry.word_indices !== undefined && entry.word_indices.length > 0) {
      // TIGHT: pick the named words on the first line.
      const firstLine = lines[0]!;
      const words: OcrWord[] = [];
      for (const wIdx of entry.word_indices) {
        const w = firstLine.words[wIdx];
        if (w === undefined) return null;
        words.push(w);
      }
      return this.unionToOriginalFrame(entry.page, words);
    }

    // ROW: union every word across every named line.
    const allWords = lines.flatMap((line) => line.words);
    if (allWords.length === 0) return null;
    return this.unionToOriginalFrame(entry.page, allWords);
  }

  // ------------------------------------------------------------------
  // Mechanical fallback path
  // ------------------------------------------------------------------

  /**
   * TIGHT fallback: find a contiguous run of OCR words on a single
   * line whose joined tokens match `value`. Returns the union bbox of
   * just those words, translated back into the original frame.
   * Returns null on no match.
   */
  locateTight(value: string): Bbox | null {
    const tokens = tokenize(value);
    if (tokens.length === 0) return null;

    for (const ocr of this.ocrPages) {
      for (const line of ocr.lines) {
        const start = findTokenRunStart(line.words, tokens);
        if (start < 0) continue;
        const slice = line.words.slice(start, start + tokens.length);
        return this.unionToOriginalFrame(ocr.page, slice);
      }
    }
    return null;
  }

  /**
   * ROW fallback: scan every OCR line and pick the one with the
   * highest token-overlap against the row's anchors. Returns the full
   * line bbox. Returns null when no line shares any token.
   */
  locateRow(anchors: ReadonlyArray<string>): Bbox | null {
    if (anchors.length === 0) return null;
    const allTokens = new Set<string>();
    for (const a of anchors) {
      for (const t of tokenize(a)) allTokens.add(t);
    }
    if (allTokens.size === 0) return null;

    let best: { ocr: OcrPage; line: OcrLine; score: number } | null = null;

    for (const ocr of this.ocrPages) {
      for (const line of ocr.lines) {
        const lineTokens = new Set<string>();
        for (const w of line.words) {
          for (const t of tokenize(w.text)) lineTokens.add(t);
        }
        let score = 0;
        for (const t of allTokens) if (lineTokens.has(t)) score += 1;
        if (score > 0 && (best === null || score > best.score)) {
          best = { ocr, line, score };
        }
      }
    }

    if (best === null) return null;
    return this.lineToOriginalFrame(best.ocr.page, best.line);
  }

  // ------------------------------------------------------------------
  // Frame translation
  // ------------------------------------------------------------------

  private unionToOriginalFrame(pageIdx: number, words: ReadonlyArray<OcrWord>): Bbox {
    if (words.length === 0) return ZERO_BBOX;
    const frame = this.framesByPage.get(pageIdx);
    if (frame === undefined) return ZERO_BBOX;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const w of words) {
      minX = Math.min(minX, w.x);
      minY = Math.min(minY, w.y);
      maxX = Math.max(maxX, w.x + w.w);
      maxY = Math.max(maxY, w.y + w.h);
    }
    return this.translate(pageIdx, frame, minX, minY, maxX - minX, maxY - minY);
  }

  private lineToOriginalFrame(pageIdx: number, line: OcrLine): Bbox {
    const frame = this.framesByPage.get(pageIdx);
    if (frame === undefined) return ZERO_BBOX;
    return this.translate(pageIdx, frame, line.x, line.y, line.w, line.h);
  }

  private translate(
    pageIdx: number,
    frame: FrameInfo,
    x: number,
    y: number,
    w: number,
    h: number,
  ): Bbox {
    return {
      page: pageIdx,
      x: x + frame.trimOffsetLeft,
      y: y + frame.trimOffsetTop,
      w,
      h,
      image_w: frame.originalWidth,
      image_h: frame.originalHeight,
    };
  }
}

// ------------------------------------------------------------------
// Entity-list builders (input to LlmBboxSelector)
// ------------------------------------------------------------------

/**
 * Flatten a VlmLabPdf into the entity list LlmBboxSelector consumes.
 * Entity IDs match the keys BboxLocator looks up via `locatePlanned`.
 */
export function entitiesFromLabPdf(vlm: VlmLabPdf): BboxSelectorEntity[] {
  const out: BboxSelectorEntity[] = [];
  if (vlm.patient_on_document?.name) {
    out.push({
      entity_id: 'patient_on_document',
      mode: 'tight',
      text: vlm.patient_on_document.name,
    });
  }
  vlm.results.forEach((r, i) => {
    const summary = compact([r.test_name, r.display_value, r.unit, r.reference_range.raw_text])
      .join(' | ');
    out.push({ entity_id: `results[${i}]`, mode: 'row', text: summary });
  });
  return out;
}

/** Flatten a VlmIntakeForm into the entity list. */
export function entitiesFromIntakeForm(vlm: VlmIntakeForm): BboxSelectorEntity[] {
  const out: BboxSelectorEntity[] = [];
  for (const [key, value] of Object.entries(vlm.demographics.field_values)) {
    out.push({ entity_id: `demographics.field_values.${key}`, mode: 'tight', text: value });
  }
  if (vlm.chief_concern) {
    out.push({ entity_id: 'chief_concern', mode: 'row', text: vlm.chief_concern.text });
  }
  vlm.current_medications.forEach((m, i) => {
    out.push({
      entity_id: `current_medications[${i}]`,
      mode: 'row',
      text: compact([m.name, m.dose, m.frequency, m.route]).join(' | '),
    });
  });
  vlm.allergies.forEach((a, i) => {
    out.push({
      entity_id: `allergies[${i}]`,
      mode: 'row',
      text: compact([a.substance, a.reaction]).join(' | '),
    });
  });
  vlm.family_history.forEach((f, i) => {
    out.push({
      entity_id: `family_history[${i}]`,
      mode: 'row',
      text: compact([f.relation, ...f.conditions]).join(' | '),
    });
  });
  return out;
}

// ------------------------------------------------------------------
// Token utilities (shared with the mechanical fallback)
// ------------------------------------------------------------------

function tokenize(s: string): string[] {
  return s
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

function findTokenRunStart(words: ReadonlyArray<OcrWord>, target: ReadonlyArray<string>): number {
  if (target.length === 0) return -1;
  const flat: Array<{ token: string; wordIdx: number }> = [];
  words.forEach((w, idx) => {
    for (const t of tokenize(w.text)) flat.push({ token: t, wordIdx: idx });
  });
  for (let i = 0; i <= flat.length - target.length; i += 1) {
    let ok = true;
    for (let j = 0; j < target.length; j += 1) {
      if (flat[i + j]!.token !== target[j]) { ok = false; break; }
    }
    if (ok) return flat[i]!.wordIdx;
  }
  return -1;
}

function compact(values: ReadonlyArray<string | null | undefined>): string[] {
  return values.filter((v): v is string => typeof v === 'string' && v.length > 0);
}
