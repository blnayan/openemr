/**
 * LabPdfSchema — strict-schema contract for VLM extraction of lab PDFs.
 *
 * The VLM is prompted to return JSON matching this schema; the
 * extraction pipeline Zod-parses the response and retries once with
 * the validation error fed back if the first attempt fails.
 *
 * Shape choices (per W2_PRD.md §"Schemas"):
 * - `value` is split into `numeric_value` and `display_value` so
 *   qualitative results ("Negative", "No growth") preserve their
 *   string form while quantitative results power lab-trend math.
 * - LOINC codes are extracted opportunistically — most lab PDFs print
 *   them but we don't fail when they're absent.
 * - Reference range carries structured `low`/`high` plus a `raw_text`
 *   fallback so non-numeric ranges ("<5.7", "0–10 mg/dL") survive.
 * - Abnormal flags use FHIR-aligned codes (N/L/H/LL/HH/A) so
 *   write-through to FHIR Observation in issue 04 is clean.
 * - `vlm_confidence` is the model's self-reported confidence;
 *   `citation_confidence` carries the post-extraction trust label
 *   (verified | disputed | low_confidence | unverifiable). Issue 02
 *   leaves citation_confidence at the default; issue 07 (crop-and-
 *   verify, deferred) tightens it.
 */

import { z } from 'zod';
import { BboxSchema } from './Bbox.js';

export const LAB_PDF_SCHEMA_VERSION = '1';

export const ReferenceRangeSchema = z.object({
  low: z.number().nullable(),
  high: z.number().nullable(),
  raw_text: z.string(),
});

export const AbnormalFlagSchema = z.enum(['N', 'L', 'H', 'LL', 'HH', 'A']).nullable();

export const CitationConfidenceSchema = z.enum([
  'verified',
  'disputed',
  'low_confidence',
  'unverifiable',
]);

export const LabResultSchema = z.object({
  test_name: z.string().min(1),
  loinc_code: z.string().nullable(),
  numeric_value: z.number().nullable(),
  display_value: z.string().min(1),
  unit: z.string().nullable(),
  reference_range: ReferenceRangeSchema,
  abnormal_flag: AbnormalFlagSchema,
  collection_date: z.string().datetime({ offset: true, local: true }).nullable(),
  bbox: BboxSchema,
  vlm_confidence: z.number().min(0).max(1),
  citation_confidence: CitationConfidenceSchema,
});

export const PatientOnDocumentSchema = z.object({
  name: z.string().nullable(),
  bbox: BboxSchema.nullable(),
});

export const SourceCitationSchema = z.object({
  document_id: z.string(),
  page_count: z.number().int().positive(),
});

export const LabPdfSchema = z.object({
  doc_type: z.literal('lab_pdf'),
  schema_version: z.literal(LAB_PDF_SCHEMA_VERSION),
  performing_lab: z.string().nullable(),
  ordering_provider: z.string().nullable(),
  collection_date_default: z.string().datetime({ offset: true, local: true }).nullable(),
  patient_on_document: PatientOnDocumentSchema.nullable(),
  results: z.array(LabResultSchema),
  source_citation: SourceCitationSchema,
});

export type LabPdf = z.infer<typeof LabPdfSchema>;
export type LabResult = z.infer<typeof LabResultSchema>;
export type ReferenceRange = z.infer<typeof ReferenceRangeSchema>;
export type AbnormalFlag = z.infer<typeof AbnormalFlagSchema>;
export type CitationConfidence = z.infer<typeof CitationConfidenceSchema>;
