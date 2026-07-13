/**
 * Clinical severity logic — pure functions for translating raw FHIR codes
 * into the design's three-bucket severity model used by the Allergies card.
 *
 * IMPORTANT: this module is the *only* place the severity-bucket mapping
 * lives. Components import the bucket and pick a CSS class — they don't
 * make their own decisions about what counts as "moderate" vs "mild". A
 * future slice (#30) will add `interpretLabFlag(observation)` for the Labs
 * card; that lives next to this for the same reason.
 *
 * Severity tinting (full-row tinted backgrounds) is reserved for Allergies
 * by design. See the W2 PRD § "Implementation Decisions" — generalizing
 * tinted rows to other cards would dilute the safety signal.
 */

/**
 * The three design buckets. Each maps to a `(--*-bg, --severe|--warn|--ink-muted)`
 * pair in `tokens.css`.
 *
 *   - 'moderate' → red full-row tint (highest severity surfaced visually)
 *   - 'mild'     → amber full-row tint
 *   - 'unknown'  → grey full-row tint
 */
export type AllergySeverityBucket = 'moderate' | 'mild' | 'unknown';

/**
 * Map FHIR `AllergyIntolerance.criticality` + first-reaction severity to a
 * design bucket. Pure / deterministic / table-driven so unit tests cover
 * every cell of the matrix.
 *
 * Rules (in priority order, applied top-to-bottom — first match wins):
 *
 *   1. `criticality === 'high'`                     → moderate (red)
 *   2. `reactionSeverity === 'severe'`              → moderate (red)
 *   3. `reactionSeverity === 'moderate'`            → moderate (red)
 *   4. `criticality === 'low'`                      → mild     (amber)
 *   5. `reactionSeverity === 'mild'`                → mild     (amber)
 *   6. anything else (`undefined`, `'unable-to-assess'`, unknown values)
 *                                                   → unknown  (grey)
 *
 * The `criticality === 'high'` rule outranks any reaction.severity because
 * a high-criticality allergy is a safety signal regardless of whether a
 * specific reaction was ever recorded.
 */
export function interpretAllergySeverity(
  criticality: string | null | undefined,
  reactionSeverity: string | null | undefined,
): AllergySeverityBucket {
  if (criticality === 'high') {
    return 'moderate';
  }
  if (reactionSeverity === 'severe' || reactionSeverity === 'moderate') {
    return 'moderate';
  }
  if (criticality === 'low') {
    return 'mild';
  }
  if (reactionSeverity === 'mild') {
    return 'mild';
  }
  return 'unknown';
}
