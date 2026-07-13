/**
 * IntakeFormSchema — strict-schema contract for VLM extraction of
 * patient intake forms. Mirrors the LabPdfSchema shape decisions:
 *
 * - Demographics are extracted as patient-self-reported only — no
 *   auto-reconciliation against the OpenEMR chart at extraction
 *   time. Reconciliation ("the form says X but the chart says Y") is
 *   the supervisor's job at chat time.
 * - chief_concern is nullable so a blank-but-present field doesn't
 *   trigger fabrication.
 * - Family-history relation is a closed enum with an `other` escape
 *   valve so eval rubrics can assert closed semantics while still
 *   capturing rare relationships.
 * - Allergy severity is nullable since most intake forms don't capture
 *   it; forcing it would make the schema_valid rubric fire false
 *   negatives.
 * - Every atomic field carries a bbox — this is the citation contract
 *   half of the issue 02/03 pipeline.
 *
 * Partial write-through (W2_DOCUMENT_INBOX_PRD §"Backend split"). After
 * a clinician confirms an intake extraction in the Document Inbox, the
 * PHP-side `IntakeWriter` rounds these buckets into OpenEMR surfaces:
 *
 *   - `current_medications[]` → `lists` rows (type='medication')
 *   - `allergies[]` → `lists` rows (type='allergy')
 *   - `chief_concern.text` → a `pnotes` row tagged as intake-derived
 *
 * Demographics merge and `family_history` round-trip are explicitly out
 * of scope — those buckets stay sidecar-only on this side as well.
 * `bbox` data continues to live in the sidecar regardless of which
 * buckets round-trip; the bbox overlay viewer reads from the sidecar.
 */

import { z } from 'zod';
import { BboxSchema } from './Bbox.js';

export const INTAKE_FORM_SCHEMA_VERSION = '1';

export const FamilyRelationSchema = z.enum([
  'mother',
  'father',
  'sibling',
  'child',
  'grandparent_maternal',
  'grandparent_paternal',
  'other',
]);

export const AllergySeveritySchema = z.enum(['mild', 'moderate', 'severe', 'unknown']).nullable();

export const SexSchema = z.enum(['M', 'F', 'other', 'unknown']).nullable();

export const IntakeMedicationSchema = z.object({
  name: z.string().min(1),
  dose: z.string().nullable(),
  frequency: z.string().nullable(),
  route: z.string().nullable(),
  is_otc_or_supplement: z.boolean(),
  bbox: BboxSchema,
});

export const IntakeAllergySchema = z.object({
  substance: z.string().min(1),
  reaction: z.string().nullable(),
  severity: AllergySeveritySchema,
  bbox: BboxSchema,
});

export const FamilyHistoryEntrySchema = z.object({
  relation: FamilyRelationSchema,
  conditions: z.array(z.string().min(1)),
  bbox: BboxSchema,
});

export const IntakeChiefConcernSchema = z.object({
  text: z.string().min(1),
  bbox: BboxSchema,
}).nullable();

export const IntakeDemographicsSchema = z.object({
  name: z.string().nullable(),
  dob: z.string().date().nullable(),
  sex: SexSchema,
  bbox_per_field: z.record(z.string(), BboxSchema),
});

export const IntakeSourceCitationSchema = z.object({
  document_id: z.string(),
  page_count: z.number().int().positive(),
});

export const IntakeFormSchema = z.object({
  doc_type: z.literal('intake_form'),
  schema_version: z.literal(INTAKE_FORM_SCHEMA_VERSION),
  demographics: IntakeDemographicsSchema,
  chief_concern: IntakeChiefConcernSchema,
  current_medications: z.array(IntakeMedicationSchema),
  allergies: z.array(IntakeAllergySchema),
  family_history: z.array(FamilyHistoryEntrySchema),
  source_citation: IntakeSourceCitationSchema,
});

export type IntakeForm = z.infer<typeof IntakeFormSchema>;
export type IntakeMedication = z.infer<typeof IntakeMedicationSchema>;
export type IntakeAllergy = z.infer<typeof IntakeAllergySchema>;
export type FamilyHistoryEntry = z.infer<typeof FamilyHistoryEntrySchema>;
export type FamilyRelation = z.infer<typeof FamilyRelationSchema>;
