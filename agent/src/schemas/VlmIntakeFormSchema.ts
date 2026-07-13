/**
 * VlmIntakeFormSchema — the contract the VLM is asked to honour for
 * intake forms in the new OCR-anchored flow. Bbox slots removed
 * (BboxLocator fills them post-extraction). Mirror of
 * IntakeFormSchema otherwise.
 */

import { z } from 'zod';
import {
  AllergySeveritySchema,
  FamilyRelationSchema,
  INTAKE_FORM_SCHEMA_VERSION,
  IntakeSourceCitationSchema,
  SexSchema,
} from './IntakeFormSchema.js';

export const VlmIntakeMedicationSchema = z.object({
  name: z.string().min(1),
  dose: z.string().nullable(),
  frequency: z.string().nullable(),
  route: z.string().nullable(),
  is_otc_or_supplement: z.boolean(),
});

export const VlmIntakeAllergySchema = z.object({
  substance: z.string().min(1),
  reaction: z.string().nullable(),
  severity: AllergySeveritySchema,
});

export const VlmFamilyHistoryEntrySchema = z.object({
  relation: FamilyRelationSchema,
  conditions: z.array(z.string().min(1)),
});

export const VlmIntakeChiefConcernSchema = z.object({
  text: z.string().min(1),
}).nullable();

export const VlmIntakeDemographicsSchema = z.object({
  name: z.string().nullable(),
  dob: z.string().date().nullable(),
  sex: SexSchema,
  /**
   * Verbatim values for any demographic fields the form actually shows.
   * Keys may include "name", "dob", "sex", "phone", "address". The
   * BboxLocator uses these strings to anchor TIGHT bboxes on the page;
   * the structured top-level fields above remain the canonical values.
   */
  field_values: z.record(z.string(), z.string().min(1)),
});

export const VlmIntakeFormSchema = z.object({
  doc_type: z.literal('intake_form'),
  schema_version: z.literal(INTAKE_FORM_SCHEMA_VERSION),
  demographics: VlmIntakeDemographicsSchema,
  chief_concern: VlmIntakeChiefConcernSchema,
  current_medications: z.array(VlmIntakeMedicationSchema),
  allergies: z.array(VlmIntakeAllergySchema),
  family_history: z.array(VlmFamilyHistoryEntrySchema),
  source_citation: IntakeSourceCitationSchema,
});

export type VlmIntakeForm = z.infer<typeof VlmIntakeFormSchema>;
export type VlmIntakeMedication = z.infer<typeof VlmIntakeMedicationSchema>;
export type VlmIntakeAllergy = z.infer<typeof VlmIntakeAllergySchema>;
export type VlmFamilyHistoryEntry = z.infer<typeof VlmFamilyHistoryEntrySchema>;
