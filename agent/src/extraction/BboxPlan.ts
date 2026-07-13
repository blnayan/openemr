/**
 * BboxPlan — the LLM-produced map from extracted entities to OCR
 * line/word indices.
 *
 * The previous mechanical locator (token-overlap on Tesseract lines)
 * fails when Tesseract splits a single visual row across multiple
 * OCR lines (e.g. an eGFR row whose unit "mL/min/1.73m²" wraps to a
 * second line). Both half-lines have legitimate token overlap with
 * the row's text, so the scorer can't decide which to pick — and
 * either choice produces a too-tight bbox that misses half the row.
 *
 * The fix: an LLM step that sees the OCR line list AND the structured
 * extraction, and emits a plan saying "row results[3] = union of OCR
 * lines [11, 12]". The locator then mechanically unions those line
 * bboxes — no scoring, no guessing.
 *
 * Entity IDs are stable JSON-path-like strings the locator uses to
 * look up plan entries:
 *   - "patient_on_document"
 *   - "results[0]", "results[1]", ...
 *   - "demographics.name", "demographics.dob", "demographics.field_values.phone"
 *   - "chief_concern"
 *   - "current_medications[0]", "allergies[0]", "family_history[0]", ...
 *
 * TIGHT vs ROW:
 *   - ROW entities (lab results, medications, allergies, family
 *     history, chief concern) provide line_indices only — the locator
 *     unions every word across those lines.
 *   - TIGHT entities (patient name, demographic field values) provide
 *     line_indices PLUS word_indices within those lines, so the
 *     highlight hugs just the value tokens.
 */

import { z } from 'zod';

export const BboxPlanEntrySchema = z.object({
  /** Stable JSON-path-like ID of the extracted entity. */
  entity_id: z.string().min(1),
  /** Page index this entity lives on. */
  page: z.number().int().nonnegative(),
  /**
   * OCR line indices that constitute this entity's bbox. Multiple
   * indices = the row wraps; the locator unions them.
   * Must be a non-empty list and indices must be in-range for the
   * named page (locator validates).
   */
  line_indices: z.array(z.number().int().nonnegative()).min(1),
  /**
   * For TIGHT entities only: word indices within the (single)
   * line_indices entry that the highlight should hug. When omitted
   * or empty, the locator unions every word across line_indices
   * (ROW mode).
   *
   * Convention: word_indices apply to the FIRST line in line_indices
   * — TIGHT entities are always single-line.
   */
  word_indices: z.array(z.number().int().nonnegative()).optional(),
});

export const BboxPlanSchema = z.object({
  entries: z.array(BboxPlanEntrySchema),
});

export type BboxPlanEntry = z.infer<typeof BboxPlanEntrySchema>;
export type BboxPlan = z.infer<typeof BboxPlanSchema>;
