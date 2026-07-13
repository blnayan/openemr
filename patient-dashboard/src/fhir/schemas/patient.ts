/**
 * Zod schema + DTO projection for the FHIR R4 `Patient` resource subset
 * the dashboard actually consumes.
 *
 * Parse-don't-validate: every code path past `parsePatient()` works with the
 * narrow `PatientDTO` — never the raw FHIR resource. If FHIR adds a field we
 * later need (e.g. address, telecom), extend the schema here and re-project.
 *
 * MRN identifier: the OpenEMR FHIR server emits the public patient id (the
 * value clinicians know as the MRN) as an `Identifier` with
 * `type.coding[].code === 'PT'` and system
 * `http://terminology.hl7.org/CodeSystem/v2-0203`. See
 * `src/Services/FHIR/FhirPatientService.php::parseOpenEMRPublicPatientIdentifier`.
 * We pick the first `PT`-coded identifier; if none exists we fall back to the
 * first identifier value, and finally to an empty string. The fallback chain
 * keeps the strip from blowing up on partial data.
 */

import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Raw FHIR shape (only the fields we consume)                                */
/* -------------------------------------------------------------------------- */

const FhirHumanNameSchema = z.object({
  use: z.string().optional(),
  family: z.string().optional(),
  given: z.array(z.string()).optional(),
});

const FhirCodingSchema = z.object({
  system: z.string().optional(),
  code: z.string().optional(),
  display: z.string().optional(),
});

const FhirCodeableConceptSchema = z.object({
  coding: z.array(FhirCodingSchema).optional(),
  text: z.string().optional(),
});

const FhirIdentifierSchema = z.object({
  use: z.string().optional(),
  system: z.string().optional(),
  value: z.string().optional(),
  type: FhirCodeableConceptSchema.optional(),
});

export const FhirPatientSchema = z.object({
  resourceType: z.literal('Patient'),
  id: z.string(),
  active: z.boolean().optional(),
  name: z.array(FhirHumanNameSchema).optional(),
  gender: z.string().optional(),
  birthDate: z.string().optional(),
  identifier: z.array(FhirIdentifierSchema).optional(),
});

export type FhirPatient = z.infer<typeof FhirPatientSchema>;

/* -------------------------------------------------------------------------- */
/* DTO — what every consumer past the parse boundary works with               */
/* -------------------------------------------------------------------------- */

export interface PatientDTO {
  /** FHIR resource id (UUID in OpenEMR). */
  id: string;
  /** Joined display name, e.g. "Margaret L. Chen". Empty string if unknown. */
  name: string;
  /** Joined given names, e.g. "Margaret L.". */
  given: string;
  /** Family / surname. */
  family: string;
  /** ISO date `YYYY-MM-DD`, or null if absent. */
  birthDate: string | null;
  /** FHIR administrative-gender code (`male` / `female` / `other` / `unknown`). */
  gender: string | null;
  /** Public MRN string. Empty if no identifier present. */
  mrn: string;
  /** Defaults to `true` when FHIR omits the field — matches OpenEMR's seed data. */
  active: boolean;
}

const MR_TYPE_CODE = 'PT';

function pickMrn(identifiers: FhirPatient['identifier']): string {
  if (!identifiers || identifiers.length === 0) {
    return '';
  }
  const ptCoded = identifiers.find((id) =>
    id.type?.coding?.some((c) => c.code === MR_TYPE_CODE),
  );
  if (ptCoded?.value !== undefined) {
    return ptCoded.value;
  }
  // Fall back to the first identifier with a value so we never render a blank
  // MRN slot when the server emits a non-PT-coded identifier.
  const firstWithValue = identifiers.find((id) => typeof id.value === 'string');
  return firstWithValue?.value ?? '';
}

function joinName(name: FhirPatient['name']): {
  full: string;
  given: string;
  family: string;
} {
  const primary = name && name.length > 0 ? name[0] : undefined;
  const given = primary?.given?.join(' ') ?? '';
  const family = primary?.family ?? '';
  const full = [given, family].filter((s) => s.length > 0).join(' ');
  return { full, given, family };
}

/**
 * Parse a raw FHIR Patient response (already JSON-decoded) into the narrow
 * `PatientDTO`. Throws `ZodError` if the shape doesn't match the FHIR schema.
 */
export function parsePatient(raw: unknown): PatientDTO {
  const fhir = FhirPatientSchema.parse(raw);
  const { full, given, family } = joinName(fhir.name);
  return {
    id: fhir.id,
    name: full,
    given,
    family,
    birthDate: fhir.birthDate ?? null,
    gender: fhir.gender ?? null,
    mrn: pickMrn(fhir.identifier),
    active: fhir.active ?? true,
  };
}
