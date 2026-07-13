/**
 * citationIdsForRow — single-source-of-truth for the citation_ids array
 * attached to a claim derived from a tool row.
 *
 * Always includes the canonical `tool:<name>:row-<n>` id. When the row
 * carries a `source` field of `kind: 'document'` (decorated by tools that
 * call ResourceOriginLookup), also appends the source-document
 * attribution id:
 *
 *   - `doc:intake-<document_id>` for rows backed by `lists` (the
 *     IntakeWriter destination — currently medications and allergies).
 *   - `doc:lab-<document_id>`    for rows backed by `procedure_*` (the
 *     LabFhirWriter destination — currently observations / labs).
 *
 * Used by both runPrevisit and runFollowup so the citation-pill UI shows
 * the same provenance regardless of entry path.
 */

const INTAKE_TOOLS = new Set<string>(['get_allergies', 'get_medications']);

export function citationIdsForRow(row: { id: string; [k: string]: unknown }): string[] {
  const ids: string[] = [String(row.id)];
  const src = row['source'];
  if (!src || typeof src !== 'object' || Array.isArray(src)) return ids;

  const kind = (src as { kind?: unknown }).kind;
  const docId = (src as { document_id?: unknown }).document_id;
  if (kind !== 'document' || typeof docId !== 'number' || docId <= 0) return ids;

  const toolName = String(row.id).split(':')[1] ?? '';
  const prefix = INTAKE_TOOLS.has(toolName) ? 'intake' : 'lab';
  ids.push(`doc:${prefix}-${docId}`);
  return ids;
}
