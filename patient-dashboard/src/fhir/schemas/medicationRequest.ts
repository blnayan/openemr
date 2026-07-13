/**
 * Zod schema + DTO projection for the FHIR R4 `MedicationRequest` resource
 * subset the dashboard's Medications card consumes.
 *
 * Why `MedicationRequest` and not `MedicationStatement`? The W2 PRD's table
 * maps "Medications" to `MedicationStatement`, but OpenEMR's FHIR server
 * does not implement `patient/MedicationStatement.rs`. The SMART scopes
 * registered for the patient dashboard already drop `MedicationStatement`
 * and use `MedicationRequest` for both the Medications and Prescriptions
 * cards. In OpenEMR's data model the two cards are essentially the same
 * underlying set; #28 (Prescriptions) will distinguish via `intent` (e.g.
 * `intent === 'order'`) once both cards are live.
 *
 * Parse-don't-validate: every code path past `parseMedicationRequest()`
 * works with the narrow `MedicationRequestDTO` — never the raw FHIR
 * resource. Schema is deliberately permissive (most fields optional) since
 * OpenEMR emits inconsistent shapes for legacy meds entered before
 * structured dosing was tracked. Filtering of inactive entries lives one
 * level up in the `useMedications` hook so the schema stays purely about
 * shape, not policy.
 */

import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Raw FHIR shape (only the fields we consume)                                */
/* -------------------------------------------------------------------------- */

const FhirCodingSchema = z.object({
  system: z.string().optional(),
  code: z.string().optional(),
  display: z.string().optional(),
});

const FhirCodeableConceptSchema = z.object({
  coding: z.array(FhirCodingSchema).optional(),
  text: z.string().optional(),
});

const FhirReferenceSchema = z.object({
  reference: z.string().optional(),
  display: z.string().optional(),
});

const FhirQuantitySchema = z.object({
  value: z.number().optional(),
  unit: z.string().optional(),
  system: z.string().optional(),
  code: z.string().optional(),
});

const FhirDoseAndRateSchema = z.object({
  doseQuantity: FhirQuantitySchema.optional(),
});

const FhirDosageSchema = z.object({
  text: z.string().optional(),
  doseAndRate: z.array(FhirDoseAndRateSchema).optional(),
});

export const FhirMedicationRequestSchema = z.object({
  resourceType: z.literal('MedicationRequest'),
  id: z.string(),
  status: z.string().optional(),
  intent: z.string().optional(),
  medicationCodeableConcept: FhirCodeableConceptSchema.optional(),
  medicationReference: FhirReferenceSchema.optional(),
  dosageInstruction: z.array(FhirDosageSchema).optional(),
  // FHIR R4 ISO date(time) string; we keep it as a raw string and let cards
  // render or future code parse. No Date construction here — that's a
  // UTC-vs-local trap (see CLAUDE.md gotchas).
  authoredOn: z.string().optional(),
});

export type FhirMedicationRequest = z.infer<typeof FhirMedicationRequestSchema>;

/* -------------------------------------------------------------------------- */
/* DTO — what every consumer past the parse boundary works with               */
/* -------------------------------------------------------------------------- */

export interface MedicationRequestDTO {
  /** FHIR resource id. */
  id: string;
  /**
   * Display name of the medication. Resolved in this order:
   *   1. medicationCodeableConcept.coding[0].display
   *   2. medicationReference.display
   *   3. medicationCodeableConcept.text
   * Falls back to `'(unknown medication)'` if none are present so the row
   * always renders something readable.
   */
  name: string;
  /**
   * Free-text dosing string (e.g. "Take 1 tablet by mouth daily"). Falls
   * back to a structured "<value> <unit>" string from `doseQuantity` if
   * `dosageInstruction[0].text` is missing. `null` when no dosing info is
   * available at all.
   */
  dosingText: string | null;
  /**
   * FHIR `MedicationRequest.status` — one of `active`, `on-hold`,
   * `cancelled`, `completed`, `entered-in-error`, `stopped`, `draft`,
   * `unknown`. `null` when the server omits status. The hook filters to
   * `active` only.
   */
  status: string | null;
  /**
   * FHIR `MedicationRequest.intent` — one of `proposal`, `plan`, `order`,
   * `original-order`, `reflex-order`, `filler-order`, `instance-order`,
   * `option`. `null` when absent. Used by the Prescriptions card (#28) to
   * distinguish prescription orders from non-order medications.
   */
  intent: string | null;
  /** Raw FHIR `authoredOn` string (ISO); null when absent. */
  authoredOn: string | null;
}

function pickMedicationName(fhir: FhirMedicationRequest): string {
  const codedDisplay = fhir.medicationCodeableConcept?.coding?.find(
    (c) => typeof c.display === 'string' && c.display.length > 0,
  );
  if (codedDisplay?.display !== undefined) {
    return codedDisplay.display;
  }
  const refDisplay = fhir.medicationReference?.display;
  if (typeof refDisplay === 'string' && refDisplay.length > 0) {
    return refDisplay;
  }
  const text = fhir.medicationCodeableConcept?.text;
  if (typeof text === 'string' && text.length > 0) {
    return text;
  }
  return '(unknown medication)';
}

function pickDosingText(fhir: FhirMedicationRequest): string | null {
  const first = fhir.dosageInstruction?.[0];
  if (first === undefined) {
    return null;
  }
  if (typeof first.text === 'string' && first.text.length > 0) {
    return first.text;
  }
  // Fall back to a structured "<value> <unit>" rendering if free-text is
  // missing. Both fields are optional in FHIR; we only emit a string when
  // the value is present so we never render orphaned units.
  const dose = first.doseAndRate?.[0]?.doseQuantity;
  if (dose === undefined || typeof dose.value !== 'number') {
    return null;
  }
  if (typeof dose.unit === 'string' && dose.unit.length > 0) {
    return `${dose.value} ${dose.unit}`;
  }
  return String(dose.value);
}

/**
 * Parse a raw FHIR MedicationRequest resource (already JSON-decoded) into
 * the narrow `MedicationRequestDTO`. Throws `ZodError` if the shape doesn't
 * match.
 */
export function parseMedicationRequest(raw: unknown): MedicationRequestDTO {
  const fhir = FhirMedicationRequestSchema.parse(raw);
  return {
    id: fhir.id,
    name: pickMedicationName(fhir),
    dosingText: pickDosingText(fhir),
    status: fhir.status ?? null,
    intent: fhir.intent ?? null,
    authoredOn: fhir.authoredOn ?? null,
  };
}
