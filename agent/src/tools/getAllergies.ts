import type { ToolContext, ToolResult, ToolRow, SourceAttribution } from './types.js';
import { fhirErrorToReason } from './types.js';

const TOOL_NAME = 'get_allergies';

export async function getAllergies(
  _params: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  try {
    const bundle = await context.fhirClient.searchBundle<fhir4.AllergyIntolerance>(
      'AllergyIntolerance',
      { patient: context.patientUuid },
    );

    const allergies = (bundle.entry ?? [])
      .map(e => e.resource)
      .filter((r): r is fhir4.AllergyIntolerance => Boolean(r));

    // FHIR AllergyIntolerance resources are backed by `lists` rows with
    // type='allergy' in OpenEMR; the resource id IS the lists.uuid.
    const sourceByUuid = await resolveSources(context, allergies.map(a => a.id ?? ''));

    const rows: ToolRow[] = allergies.map((all, i) => ({
      id: `tool:${TOOL_NAME}:row-${i}`,
      allergen: all.code?.text ?? all.code?.coding?.[0]?.display ?? null,
      criticality: all.criticality ?? 'unknown',
      reaction: all.reaction?.[0]?.manifestation?.[0]?.text ?? null,
      source: sourceByUuid.get(all.id ?? '') ?? { kind: 'chart' } satisfies SourceAttribution,
    }));

    return { ok: true, rows, tool: TOOL_NAME };
  } catch (err) {
    return { ok: false, reason: fhirErrorToReason(err), tool: TOOL_NAME };
  }
}

async function resolveSources(
  context: ToolContext,
  uuids: ReadonlyArray<string>,
): Promise<Map<string, SourceAttribution>> {
  const out = new Map<string, SourceAttribution>();
  if (!context.originLookup) return out;
  const refs = uuids
    .filter(u => u !== '')
    .map(uuid => ({ resourceType: 'lists' as const, uuid }));
  if (refs.length === 0) return out;
  const lookup = await context.originLookup.lookup(refs);
  for (const [uuid, info] of lookup.entries()) {
    if (info) {
      out.set(uuid, {
        kind: 'document',
        document_id: info.document_id,
        document_name: info.document_name,
        document_date: info.document_date,
      });
    }
  }
  return out;
}
