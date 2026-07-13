/**
 * ReviewPanel — pure-logic helpers for the Document Inbox review panel.
 *
 * These functions are the testable core of the field-edit panel rendered
 * by {@see DocumentInboxController::renderReviewScreen()} in
 * `src/AgentForge/Controller/DocumentInboxController.php`.
 *
 * They carry no DOM or I/O dependencies, which lets the Vitest suite
 * exercise the panel behaviours documented in issue 32 without a browser.
 *
 * The inline JS in the PHP controller calls equivalent logic; keeping
 * parity between this module and the inline script is intentional.
 *
 * @package OpenEMR / AgentForge
 * @link    https://www.open-emr.org
 */

/** Minimal shape of an extracted-JSON payload as returned by the VLM. */
export interface ExtractedPayload {
  doc_type?: string;
  results?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

/**
 * Build the JSON body that will be sent to the confirm endpoint.
 *
 * For `lab_pdf` documents, rejected rows (identified by their 0-based
 * index into `extracted.results`) are filtered out before submission.
 * The server's `EditedFieldPathDiffer` will compute the diff between
 * the original sidecar copy and this payload; the diff is persisted as
 * `edited_field_paths`.
 *
 * For non-lab documents (intake forms), `rejectedRowIndices` is ignored
 * because intake forms do not have per-row rejection.
 *
 * @param extracted         Deep-clone of the extracted JSON; the caller
 *                          already applied field edits to this object.
 * @param rejectedRowIndices Set of 0-based result-row indices the reviewer
 *                          rejected; only meaningful for `lab_pdf`.
 */
export function buildSubmissionPayload(
  extracted: ExtractedPayload,
  rejectedRowIndices: Set<number>,
): ExtractedPayload {
  // Deep-clone to avoid mutating the caller's working copy.
  const payload = JSON.parse(JSON.stringify(extracted)) as ExtractedPayload;

  if (payload.doc_type === 'lab_pdf' && Array.isArray(payload.results)) {
    payload.results = payload.results.filter((_row, idx) => !rejectedRowIndices.has(idx));
  }

  return payload;
}

/**
 * Return whether the given upload-job status string puts the review
 * screen into read-only mode.
 *
 * Mirrors the PHP logic in `DocumentInboxController::renderReviewScreen()`:
 *   committed | rejected  → read-only
 *   ready_for_review       → editable
 *
 * This function is used by tests to validate the READ_ONLY constant
 * that the PHP page injects.
 */
export function isReadOnlyStatus(status: string): boolean {
  return status === 'committed' || status === 'rejected';
}

/**
 * Compute a dirty flag: returns true when the edited payload differs
 * from the original on any top-level value or nested results row.
 *
 * The server's `EditedFieldPathDiffer` does the authoritative per-path
 * diff; this helper is used client-side to decide whether to show the
 * "Edited" badge without calling the server.
 *
 * Uses `JSON.stringify` comparison for simplicity.  The badge is purely
 * cosmetic; false negatives (no badge when a field is technically
 * different) are acceptable because the server-side diff is the source
 * of truth for provenance stamping.
 */
export function computeIsDirty(
  original: ExtractedPayload,
  edited: ExtractedPayload,
): boolean {
  return JSON.stringify(original) !== JSON.stringify(edited);
}
