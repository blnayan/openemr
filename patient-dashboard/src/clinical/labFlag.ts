/**
 * Clinical lab flag logic — pure mapping from FHIR `Observation.interpretation`
 * codes to the design's four-bucket flag model used by the Lab Results card.
 *
 * IMPORTANT: this module is the *only* place the lab-flag mapping lives.
 * Components import the bucket and pick a CSS rule — they don't make their
 * own decisions about what counts as "high" vs "abnormal".
 *
 * Design constraint (per W2 PRD): out-of-range labs surface as a red foreground
 * on the *value* — NOT a tinted full-row background. Tinted rows are the
 * Allergies card's exclusive safety signal; generalizing that pattern to labs
 * would dilute it. So `LabFlag` only carries directional/abnormality info; the
 * row's chrome is unaffected.
 *
 * Flagging is driven entirely by the lab system's `interpretation` codes —
 * we deliberately do NOT re-derive flagging from `referenceRange`. The lab
 * system already applied age/sex/reference-population logic when it issued
 * the interpretation; client-side re-derivation would silently disagree with
 * the printed report.
 */

/**
 * The four design buckets for a lab result.
 *
 *   - 'high'     — value is above the reference range (codes `H` or `HH`).
 *   - 'low'      — value is below the reference range (codes `L` or `LL`).
 *   - 'abnormal' — out-of-range with no direction (code `A`).
 *   - 'normal'   — within range, explicitly normal (`N`), or no interpretation.
 *
 * `'normal'` is the safe default: an unknown / missing interpretation is
 * rendered without a flag rather than guessing.
 */
export type LabFlag = 'high' | 'low' | 'abnormal' | 'normal';

/**
 * Map an array of FHIR `Observation.interpretation[].coding[].code` values
 * to a `LabFlag` bucket. Pure / deterministic / table-driven so unit tests
 * cover every code in the HL7 v3 ObservationInterpretation value set we
 * care about, plus missing and unknown codes.
 *
 * Rules (in priority order, applied top-to-bottom — first match wins):
 *
 *   1. Any code in `{'H', 'HH'}`  → 'high'
 *   2. Any code in `{'L', 'LL'}`  → 'low'
 *   3. Any code in `{'A', 'AA'}`  → 'abnormal'
 *   4. Anything else (including `'N'`, missing, unknown, `'B'`, etc.)
 *                                  → 'normal'
 *
 * Why an array input? FHIR allows `interpretation` to be a list of
 * CodeableConcepts, each with multiple codings. We hoist the flattening up
 * to the schema layer (`parseObservation`) and pass the deduped/flattened
 * code list here, so this function stays trivially testable as pure-data.
 *
 * Priority note: `H` outranks `A` because `H`/`L` are strictly more
 * informative than the directionless `A`. If a result is somehow tagged
 * both `H` and `A`, the user gets the directional bucket.
 */
export function interpretLabFlag(codes: readonly string[]): LabFlag {
  for (const code of codes) {
    if (code === 'H' || code === 'HH') {
      return 'high';
    }
  }
  for (const code of codes) {
    if (code === 'L' || code === 'LL') {
      return 'low';
    }
  }
  for (const code of codes) {
    if (code === 'A' || code === 'AA') {
      return 'abnormal';
    }
  }
  return 'normal';
}
