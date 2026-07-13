/**
 * Zod schema + DTO projection for the FHIR R4 `AllergyIntolerance` resource
 * subset the dashboard's Allergies card consumes.
 *
 * Parse-don't-validate: every code path past `parseAllergy()` works with the
 * narrow `AllergyDTO` — never the raw FHIR resource. If we later need
 * onset / recordedDate / verificationStatus, extend the schema here and
 * re-project.
 *
 * We deliberately keep the schema *permissive*: optional everywhere except
 * `resourceType` + `id`, since OpenEMR's FHIR server occasionally omits
 * `clinicalStatus` (e.g. for allergies entered via the legacy lists table
 * before clinical-status tracking was added). Filtering of resolved/inactive
 * entries lives one level up in the hook so the schema layer stays purely
 * about shape, not policy.
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

const FhirReactionSchema = z.object({
  manifestation: z.array(FhirCodeableConceptSchema).optional(),
  // FHIR R4 enumerates: 'mild' | 'moderate' | 'severe'. We accept any string
  // and narrow downstream so an unexpected server value doesn't blow up the
  // entire card.
  severity: z.string().optional(),
});

const FhirNarrativeSchema = z.object({
  div: z.string().optional(),
  status: z.string().optional(),
});

export const FhirAllergyIntoleranceSchema = z.object({
  resourceType: z.literal('AllergyIntolerance'),
  id: z.string(),
  // 'high' | 'low' | 'unable-to-assess' per FHIR R4. Accept any string; the
  // pure severity-mapper in `clinical/severity.ts` is responsible for the
  // exhaustive narrowing. `nullish()` (rather than `optional()`) because
  // OpenEMR's FHIR server serializes the absent-criticality case as a literal
  // JSON `null` (the underlying PHP `FHIRAllergyIntoleranceCriticality` getter
  // returns null), not by omitting the key. A pure `.optional()` would
  // ZodError-throw on those rows and the entire card would render the error
  // state — see issue #36.
  criticality: z.string().nullish(),
  clinicalStatus: FhirCodeableConceptSchema.nullish(),
  verificationStatus: FhirCodeableConceptSchema.nullish(),
  code: FhirCodeableConceptSchema.nullish(),
  reaction: z.array(FhirReactionSchema).nullish(),
  // FHIR narrative — OpenEMR's PHP mapper (FhirAllergyIntoleranceService)
  // substitutes a data-absent-reason placeholder coding when there's no
  // SNOMED/RxNorm code on file, but the actual allergen name is preserved
  // here in `text.div`. See issue #38.
  text: FhirNarrativeSchema.nullish(),
});

export type FhirAllergyIntolerance = z.infer<typeof FhirAllergyIntoleranceSchema>;

/* -------------------------------------------------------------------------- */
/* DTO — what every consumer past the parse boundary works with               */
/* -------------------------------------------------------------------------- */

export interface AllergyDTO {
  /** FHIR resource id. */
  id: string;
  /** Display name of the allergen. Empty string if the server emits no code. */
  name: string;
  /** Raw FHIR criticality string (e.g. 'high'); null if absent. */
  criticality: string | null;
  /**
   * First reaction's severity (e.g. 'severe'); null if no reaction was
   * recorded. The card uses `reaction[0]` because the design surfaces a
   * single severity per row, not a per-manifestation breakdown.
   */
  reactionSeverity: string | null;
  /**
   * Clinical-status code (e.g. 'active', 'inactive', 'resolved'); null when
   * the server emits no clinicalStatus. The hook filters non-active rows.
   */
  clinicalStatus: string | null;
}

/**
 * Strip the canonical FHIR narrative wrapper (`<div xmlns='...'>...</div>`)
 * and return the inner text. If the input doesn't match the wrapper shape,
 * returns the input trimmed — callers can decide whether the result is
 * acceptable. We deliberately do NOT attempt to flatten further nested HTML;
 * for our use case the narrative is always a single text node.
 */
function stripNarrativeDiv(div: string): string {
  const match = /^<div[^>]*>([\s\S]*)<\/div>$/.exec(div.trim());
  return (match?.[1] ?? div).trim();
}

const DATA_ABSENT_REASON_SYSTEM =
  'http://terminology.hl7.org/CodeSystem/data-absent-reason';

function isDataAbsentCoding(coding: {
  system?: string | undefined;
  code?: string | undefined;
}): boolean {
  return (
    coding.system === DATA_ABSENT_REASON_SYSTEM ||
    (coding.code === 'unknown' && coding.system === DATA_ABSENT_REASON_SYSTEM)
  );
}

function pickAllergenName(resource: FhirAllergyIntolerance): string {
  const { code, text } = resource;
  if (code !== undefined && code !== null) {
    const firstDisplay = code.coding?.find(
      (c) =>
        typeof c.display === 'string' &&
        c.display.length > 0 &&
        !isDataAbsentCoding(c),
    );
    if (firstDisplay?.display !== undefined) {
      return firstDisplay.display;
    }
    if (typeof code.text === 'string' && code.text.length > 0) {
      return code.text;
    }
  }
  // Narrative-text fallback: OpenEMR stuffs the real allergen name in
  // `text.div` whenever the underlying lists row has no coded allergen.
  if (text !== undefined && text !== null && typeof text.div === 'string') {
    const inner = stripNarrativeDiv(text.div);
    if (inner.length > 0) {
      return inner;
    }
  }
  return '';
}

function pickClinicalStatus(
  status: FhirAllergyIntolerance['clinicalStatus'],
): string | null {
  if (status === undefined || status === null) {
    return null;
  }
  const firstCoded = status.coding?.find(
    (c) => typeof c.code === 'string' && c.code.length > 0,
  );
  return firstCoded?.code ?? null;
}

function pickFirstReactionSeverity(
  reaction: FhirAllergyIntolerance['reaction'],
): string | null {
  if (reaction === undefined || reaction === null || reaction.length === 0) {
    return null;
  }
  // noUncheckedIndexedAccess: explicitly handle the (impossible-by-length-check)
  // undefined case so the type narrows.
  const first = reaction[0];
  if (first === undefined) {
    return null;
  }
  return first.severity ?? null;
}

/**
 * Parse a raw FHIR AllergyIntolerance resource (already JSON-decoded) into
 * the narrow `AllergyDTO`. Throws `ZodError` if the shape doesn't match.
 */
export function parseAllergy(raw: unknown): AllergyDTO {
  const fhir = FhirAllergyIntoleranceSchema.parse(raw);
  return {
    id: fhir.id,
    name: pickAllergenName(fhir),
    criticality: fhir.criticality ?? null,
    reactionSeverity: pickFirstReactionSeverity(fhir.reaction),
    clinicalStatus: pickClinicalStatus(fhir.clinicalStatus),
  };
}
