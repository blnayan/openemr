/**
 * CitationSchema — discriminated union for the three citation source
 * types defined in W2_PRD §"Citation contract":
 *
 *   - `patient_document`: a region of an uploaded PDF (lab or intake form),
 *      addressed by extraction id + bbox, with the per-field VLM/OCR
 *      citation_confidence.
 *   - `guideline`: a chunk from the in-process Pinecone corpus
 *      (`agentforge-guidelines-v1`), addressed by chunk id + section id.
 *      Carries a verbatim `quoted_span` rather than the full chunk body
 *      so the verifier can substring-check the answer's claim against
 *      the chunk it cites.
 *   - `patient_record`: preserves Week 1's `tool:<name>:row-<n>` form so
 *      claims grounded in tool-call results stay shaped exactly as the
 *      Week 1 graph produced them.
 *
 * Every claim in a final answer carries at least one of these. The
 * verifier later refuses any claim whose `guideline` quoted_span is not
 * a substring of the chunk body it names (whitespace-only normalization;
 * see verification/guidelineVerifier.ts).
 */

import { z } from 'zod';
import { BboxSchema } from './Bbox.js';

/** Reuses Week 1's stringly-typed tool/rule citation id, kept verbatim. */
export const PatientRecordCitationIdSchema = z.string().regex(
  /^(tool:[a-z_]+:row-\d+|rule:[a-z]+:[a-zA-Z0-9_-]+)$/,
  'patient_record citation id must match tool:<name>:row-<n> or rule:<category>:<id>',
);

export const PatientRecordCitationSchema = z.object({
  type: z.literal('patient_record'),
  citation_id: PatientRecordCitationIdSchema,
});

export const PatientDocumentCitationSchema = z.object({
  type: z.literal('patient_document'),
  /**
   * Either the upload's extraction_id (when the citation points at a
   * structured field) or the document's chunk_id (when the citation
   * points at a region of the rendered page).
   */
  extraction_id: z.string().min(1),
  document_id: z.string().min(1).optional(),
  bbox: BboxSchema,
  /** [0, 1] confidence the cited region actually contains the asserted value. */
  citation_confidence: z.number().min(0).max(1),
});

export const GuidelineCitationSchema = z.object({
  type: z.literal('guideline'),
  /** Pinecone chunk id (e.g. `ada-2026-6.3a`). */
  chunk_id: z.string().min(1),
  /** Human-readable corpus name (e.g. `ADA Standards of Care in Diabetes—2026`). */
  source: z.string().min(1),
  /** Stable section identifier within the source (e.g. `6.3a`). */
  section_id: z.string().min(1),
  /**
   * Verbatim slice of the chunk body the claim is grounded in. The
   * verifier rejects the claim if this is not a substring of the
   * chunk body identified by `chunk_id` (whitespace-collapsed match).
   */
  quoted_span: z.string().min(1),
  /** Reranker score returned by the retriever for this chunk. Optional. */
  rerank_score: z.number().optional(),
});

export const CitationSchema = z.discriminatedUnion('type', [
  GuidelineCitationSchema,
  PatientDocumentCitationSchema,
  PatientRecordCitationSchema,
]);

export type GuidelineCitation = z.infer<typeof GuidelineCitationSchema>;
export type PatientDocumentCitation = z.infer<typeof PatientDocumentCitationSchema>;
export type PatientRecordCitation = z.infer<typeof PatientRecordCitationSchema>;
export type Citation = z.infer<typeof CitationSchema>;
