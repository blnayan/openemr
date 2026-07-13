/**
 * Zod schema + DTO projection for the FHIR R4 `CareTeam` resource subset
 * the dashboard's Care Team card consumes.
 *
 * One-to-many parse: a single FHIR `CareTeam` resource is a *grouping* of
 * `participant` entries. The card renders one row per participant, not one
 * row per CareTeam resource — so `parseCareTeam()` returns an
 * **array** of `CareTeamParticipantDTO` objects, unlike the other resource
 * parsers in this directory which are one-to-one. The client method
 * `fetchCareTeam` flat-maps these arrays into a single flat list of rows.
 *
 * The schema is permissive: optional everywhere except `resourceType` + `id`,
 * since OpenEMR's FHIR server can emit CareTeam resources with sparse data
 * (missing role display, missing member display, etc.). Defensive defaults
 * live in the projection below; filtering of inactive/entered-in-error rows
 * lives in the `useCareTeam` hook so the schema layer stays purely about
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

const FhirParticipantSchema = z.object({
  id: z.string().optional(),
  role: z.array(FhirCodeableConceptSchema).optional(),
  member: FhirReferenceSchema.optional(),
});

export const FhirCareTeamSchema = z.object({
  resourceType: z.literal('CareTeam'),
  id: z.string(),
  status: z.string().optional(),
  participant: z.array(FhirParticipantSchema).optional(),
});

export type FhirCareTeam = z.infer<typeof FhirCareTeamSchema>;

/* -------------------------------------------------------------------------- */
/* DTO — what every consumer past the parse boundary works with               */
/* -------------------------------------------------------------------------- */

export interface CareTeamParticipantDTO {
  /** FHIR `CareTeam.id` of the parent grouping resource. */
  careTeamId: string;
  /**
   * Stable id unique within the dashboard list. We synthesize it from the
   * parent CareTeam id + the participant index when the FHIR `participant.id`
   * is absent (it usually is — `participant.id` is optional in R4).
   */
  participantId: string;
  /**
   * Parent CareTeam status (e.g. `'active'`, `'inactive'`,
   * `'entered-in-error'`, `'suspended'`); null when the server emits no
   * status. The hook drops everything except `'active'` (and null, kept for
   * legacy parity with the other cards).
   */
  status: string | null;
  /**
   * Display name for the participant. Resolved from
   * `member.display` → reference text → `'(unnamed participant)'`.
   * Never an empty string; the card can always render this directly.
   */
  name: string;
  /**
   * Role label for the participant. Resolved from
   * `role[0].coding[0].display` → `role[0].text` → `'(role unspecified)'`.
   * Never an empty string.
   */
  role: string;
}

const UNNAMED_PARTICIPANT = '(unnamed participant)';
const UNSPECIFIED_ROLE = '(role unspecified)';

type FhirParticipant = NonNullable<FhirCareTeam['participant']>[number];

function pickParticipantName(member: FhirParticipant['member']): string {
  if (member === undefined) {
    return UNNAMED_PARTICIPANT;
  }
  if (typeof member.display === 'string' && member.display.length > 0) {
    return member.display;
  }
  if (typeof member.reference === 'string' && member.reference.length > 0) {
    return member.reference;
  }
  return UNNAMED_PARTICIPANT;
}

function pickParticipantRole(roleArray: FhirParticipant['role']): string {
  if (roleArray === undefined || roleArray.length === 0) {
    return UNSPECIFIED_ROLE;
  }
  const first = roleArray[0];
  if (first === undefined) {
    return UNSPECIFIED_ROLE;
  }
  const firstDisplay = first.coding?.find(
    (c) => typeof c.display === 'string' && c.display.length > 0,
  );
  if (firstDisplay?.display !== undefined) {
    return firstDisplay.display;
  }
  if (typeof first.text === 'string' && first.text.length > 0) {
    return first.text;
  }
  return UNSPECIFIED_ROLE;
}

/**
 * Parse a raw FHIR `CareTeam` resource (already JSON-decoded) into an
 * **array** of `CareTeamParticipantDTO` — one per `participant` entry on the
 * resource. Returns an empty array when the CareTeam has no participants.
 *
 * Throws `ZodError` if the shape doesn't match (e.g. wrong `resourceType`).
 */
export function parseCareTeam(raw: unknown): CareTeamParticipantDTO[] {
  const fhir = FhirCareTeamSchema.parse(raw);
  const status = fhir.status ?? null;
  const participants = fhir.participant ?? [];
  return participants.map((p, idx) => ({
    careTeamId: fhir.id,
    participantId:
      typeof p.id === 'string' && p.id.length > 0
        ? `${fhir.id}:${p.id}`
        : `${fhir.id}:${idx}`,
    status,
    name: pickParticipantName(p.member),
    role: pickParticipantRole(p.role),
  }));
}
