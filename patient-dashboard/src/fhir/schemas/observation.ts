/**
 * Zod schema + DTO projection for the FHIR R4 `Observation` resource subset
 * the dashboard's Lab Results card consumes.
 *
 * Parse-don't-validate: every code path past `parseObservation()` works with
 * the narrow `LabObservationDTO` — never the raw FHIR resource. The DTO's
 * `flag` field is pre-computed from the raw `interpretation` codes by
 * `interpretLabFlag` (see `clinical/labFlag.ts`) so consumers never have to
 * repeat the mapping.
 *
 * The schema is permissive: optional everywhere except `resourceType` + `id`,
 * since OpenEMR's FHIR server can emit Observations missing display strings,
 * units, interpretations, etc. Filtering of preliminary / cancelled /
 * entered-in-error rows lives in the `useLabResults` hook so the schema
 * stays purely about shape, not policy.
 *
 * Reference flagging note: we deliberately do NOT re-derive flagging from
 * `referenceRange[0].low|high` — the lab system's `interpretation` codes are
 * the source of truth (see W2 PRD § "Lab Results"). Reference ranges are
 * surfaced for display only.
 */

import { z } from 'zod';

import { interpretLabFlag, type LabFlag } from '../../clinical/labFlag';

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

const FhirQuantitySchema = z.object({
  value: z.number().optional(),
  unit: z.string().optional(),
  system: z.string().optional(),
  code: z.string().optional(),
});

const FhirReferenceRangeSchema = z.object({
  low: FhirQuantitySchema.optional(),
  high: FhirQuantitySchema.optional(),
  text: z.string().optional(),
});

export const FhirObservationSchema = z.object({
  resourceType: z.literal('Observation'),
  id: z.string(),
  status: z.string().optional(),
  code: FhirCodeableConceptSchema.optional(),
  valueQuantity: FhirQuantitySchema.optional(),
  valueString: z.string().optional(),
  valueCodeableConcept: FhirCodeableConceptSchema.optional(),
  interpretation: z.array(FhirCodeableConceptSchema).optional(),
  referenceRange: z.array(FhirReferenceRangeSchema).optional(),
  // FHIR R4 ISO date(time) string. Kept as a raw string; date arithmetic
  // happens in the hook (see CLAUDE.md gotcha re: `new Date('YYYY-MM-DD')`).
  effectiveDateTime: z.string().optional(),
});

export type FhirObservation = z.infer<typeof FhirObservationSchema>;

/* -------------------------------------------------------------------------- */
/* DTO — what every consumer past the parse boundary works with               */
/* -------------------------------------------------------------------------- */

export interface LabObservationDTO {
  /** FHIR resource id. */
  id: string;
  /** Test name (e.g. "Hemoglobin A1c"). Empty string when no display/text. */
  name: string;
  /**
   * Pre-formatted display value. Resolved in this priority order:
   *   1. `valueQuantity.value` + `valueQuantity.unit` (e.g. `"7.4 %"`)
   *   2. `valueString` (e.g. `"Negative"`)
   *   3. `valueCodeableConcept.coding[0].display` or `.text`
   *   4. `'(no value)'`
   * Never an empty string — the card can render this directly.
   */
  valueDisplay: string;
  /**
   * Lab-system flag. Computed once by `interpretLabFlag` from the raw
   * `interpretation[].coding[].code` array. Absent / unknown codes → `'normal'`.
   * The card uses this to decide whether the value gets the `--severe`
   * foreground color.
   */
  flag: LabFlag;
  /**
   * Pre-formatted reference range string (e.g. `"70-100 mg/dL"`), or null
   * when no range is reported. Display-only — flagging is NOT re-derived from
   * this; trust `flag`.
   */
  referenceRange: string | null;
  /** Raw FHIR `effectiveDateTime` string (ISO); null when absent. */
  effectiveDateTime: string | null;
  /**
   * Observation status code (`'final'`, `'amended'`, `'corrected'`,
   * `'preliminary'`, `'cancelled'`, `'entered-in-error'`); null when absent.
   * The hook keeps only `final` / `amended` / `corrected`.
   */
  status: string | null;
}

const NO_VALUE = '(no value)';

function pickName(code: FhirObservation['code']): string {
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

function formatQuantity(q: FhirObservation['valueQuantity']): string | null {
  if (q === undefined || typeof q.value !== 'number') {
    return null;
  }
  if (typeof q.unit === 'string' && q.unit.length > 0) {
    // Match the design's spacing convention: numeric value, space, unit.
    return `${q.value} ${q.unit}`;
  }
  return String(q.value);
}

function pickValueDisplay(fhir: FhirObservation): string {
  const quantity = formatQuantity(fhir.valueQuantity);
  if (quantity !== null) {
    return quantity;
  }
  if (typeof fhir.valueString === 'string' && fhir.valueString.length > 0) {
    return fhir.valueString;
  }
  const concept = fhir.valueCodeableConcept;
  if (concept !== undefined) {
    const firstDisplay = concept.coding?.find(
      (c) => typeof c.display === 'string' && c.display.length > 0,
    );
    if (firstDisplay?.display !== undefined) {
      return firstDisplay.display;
    }
    if (typeof concept.text === 'string' && concept.text.length > 0) {
      return concept.text;
    }
  }
  return NO_VALUE;
}

function pickInterpretationCodes(
  interp: FhirObservation['interpretation'],
): readonly string[] {
  if (interp === undefined) {
    return [];
  }
  const codes: string[] = [];
  for (const concept of interp) {
    for (const coding of concept.coding ?? []) {
      if (typeof coding.code === 'string' && coding.code.length > 0) {
        codes.push(coding.code);
      }
    }
  }
  return codes;
}

function pickReferenceRange(
  ranges: FhirObservation['referenceRange'],
): string | null {
  if (ranges === undefined || ranges.length === 0) {
    return null;
  }
  const first = ranges[0];
  if (first === undefined) {
    return null;
  }
  if (typeof first.text === 'string' && first.text.length > 0) {
    return first.text;
  }
  const lowVal = first.low?.value;
  const highVal = first.high?.value;
  if (typeof lowVal === 'number' && typeof highVal === 'number') {
    const unit = first.high?.unit ?? first.low?.unit ?? '';
    return unit.length > 0 ? `${lowVal}-${highVal} ${unit}` : `${lowVal}-${highVal}`;
  }
  if (typeof lowVal === 'number') {
    const unit = first.low?.unit ?? '';
    return unit.length > 0 ? `>= ${lowVal} ${unit}` : `>= ${lowVal}`;
  }
  if (typeof highVal === 'number') {
    const unit = first.high?.unit ?? '';
    return unit.length > 0 ? `<= ${highVal} ${unit}` : `<= ${highVal}`;
  }
  return null;
}

/**
 * Parse a raw FHIR Observation resource (already JSON-decoded) into the narrow
 * `LabObservationDTO`. Throws `ZodError` if the shape doesn't match.
 */
export function parseObservation(raw: unknown): LabObservationDTO {
  const fhir = FhirObservationSchema.parse(raw);
  return {
    id: fhir.id,
    name: pickName(fhir.code),
    valueDisplay: pickValueDisplay(fhir),
    flag: interpretLabFlag(pickInterpretationCodes(fhir.interpretation)),
    referenceRange: pickReferenceRange(fhir.referenceRange),
    effectiveDateTime: fhir.effectiveDateTime ?? null,
    status: fhir.status ?? null,
  };
}
