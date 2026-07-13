/**
 * VlmLabPdfSchema — the contract the VLM is asked to honour for lab
 * PDFs in the new OCR-anchored flow. It is the existing LabPdfSchema
 * with every bbox slot REMOVED — the VLM is no longer responsible for
 * pixel coordinates. The BboxLocator anchors each row's text against
 * Tesseract OCR output and stamps real bboxes onto the parallel
 * LabPdfSchema before the result is persisted.
 *
 * Keeping the two schemas separate (rather than `bbox.optional()`)
 * gives us a clean compile-time guarantee that nothing downstream
 * accidentally trusts a bbox the VLM might have drifted in on.
 */

import { z } from 'zod';
import {
  AbnormalFlagSchema,
  CitationConfidenceSchema,
  LAB_PDF_SCHEMA_VERSION,
  ReferenceRangeSchema,
  SourceCitationSchema,
} from './LabPdfSchema.js';

export const VlmLabResultSchema = z.object({
  test_name: z.string().min(1),
  loinc_code: z.string().nullable(),
  numeric_value: z.number().nullable(),
  display_value: z.string().min(1),
  unit: z.string().nullable(),
  reference_range: ReferenceRangeSchema,
  abnormal_flag: AbnormalFlagSchema,
  collection_date: z.string().datetime({ offset: true, local: true }).nullable(),
  vlm_confidence: z.number().min(0).max(1),
  citation_confidence: CitationConfidenceSchema,
});

export const VlmPatientOnDocumentSchema = z.object({
  name: z.string().nullable(),
});

export const VlmLabPdfSchema = z.object({
  doc_type: z.literal('lab_pdf'),
  schema_version: z.literal(LAB_PDF_SCHEMA_VERSION),
  performing_lab: z.string().nullable(),
  ordering_provider: z.string().nullable(),
  collection_date_default: z.string().datetime({ offset: true, local: true }).nullable(),
  patient_on_document: VlmPatientOnDocumentSchema.nullable(),
  results: z.array(VlmLabResultSchema),
  source_citation: SourceCitationSchema,
});

export type VlmLabPdf = z.infer<typeof VlmLabPdfSchema>;
export type VlmLabResult = z.infer<typeof VlmLabResultSchema>;
