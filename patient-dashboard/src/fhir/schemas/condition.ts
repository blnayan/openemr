/**
 * Zod schema + DTO projection for the FHIR R4 `Condition` resource subset
 * the dashboard's Medical Problems card consumes.
 *
 * Parse-don't-validate: every code path past `parseCondition()` works with
 * the narrow `ConditionDTO` — never the raw FHIR resource. If we later need
 * onset / severity / category, extend the schema here and re-project.
 *
 * The schema is deliberately permissive: optional everywhere except
 * `resourceType` + `id`, since OpenEMR's FHIR server occasionally omits
 * `clinicalStatus` for legacy issues entered before clinical-status tracking.
 * Filtering of resolved / inactive / refuted entries lives one level up in
 * the `useConditions` hook so the schema layer stays purely about shape, not
 * policy.
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

export const FhirConditionSchema = z.object({
  resourceType: z.literal('Condition'),
  id: z.string(),
  clinicalStatus: FhirCodeableConceptSchema.optional(),
  verificationStatus: FhirCodeableConceptSchema.optional(),
  code: FhirCodeableConceptSchema.optional(),
  // FHIR R4 ISO date(time) string; we keep it as a raw string and let the
  // card render it as-is or future cards parse it. No Date construction
  // here — that's a UTC-vs-local trap (see CLAUDE.md gotchas).
  recordedDate: z.string().optional(),
});

export type FhirCondition = z.infer<typeof FhirConditionSchema>;

/* -------------------------------------------------------------------------- */
/* DTO — what every consumer past the parse boundary works with               */
/* -------------------------------------------------------------------------- */

export interface ConditionDTO {
  /** FHIR resource id. */
  id: string;
  /** Display name of the condition. Empty string if the server emits no code. */
  name: string;
  /**
   * Clinical-status code (e.g. 'active', 'resolved', 'inactive', 'recurrence',
   * 'remission', 'relapse'); null when the server emits no clinicalStatus.
   * The hook filters non-active rows (active / recurrence / relapse pass).
   */
  clinicalStatus: string | null;
  /**
   * Verification-status code (e.g. 'confirmed', 'unconfirmed', 'provisional',
   * 'differential', 'refuted', 'entered-in-error'); null when absent. The
   * hook drops 'refuted' and 'entered-in-error' rows.
   */
  verificationStatus: string | null;
  /** Raw FHIR `recordedDate` string (ISO); null when absent. */
  recordedDate: string | null;
}

function pickConditionName(code: FhirCondition['code']): string {
  if (code === undefined) {
    return '';
  }
  const firstDisplay = code.coding?.find(
    (c) => typeof c.display === 'string' && c.display.length > 0,
  );
  if (firstDisplay?.display !== undefined) {
    return firstDisplay.display;
  }
  if (typeof code.text === 'string' && code.text.length > 0) {
    return code.text;
  }
  return '';
}

function pickFirstCodingCode(
  concept: FhirCondition['clinicalStatus'],
): string | null {
  if (concept === undefined) {
    return null;
  }
  const firstCoded = concept.coding?.find(
    (c) => typeof c.code === 'string' && c.code.length > 0,
  );
  return firstCoded?.code ?? null;
}

/**
 * Parse a raw FHIR Condition resource (already JSON-decoded) into the narrow
 * `ConditionDTO`. Throws `ZodError` if the shape doesn't match.
 */
export function parseCondition(raw: unknown): ConditionDTO {
  const fhir = FhirConditionSchema.parse(raw);
  return {
    id: fhir.id,
    name: pickConditionName(fhir.code),
    clinicalStatus: pickFirstCodingCode(fhir.clinicalStatus),
    verificationStatus: pickFirstCodingCode(fhir.verificationStatus),
    recordedDate: fhir.recordedDate ?? null,
  };
}
