import type { ToolContext, ToolResult, ToolRow, SourceAttribution } from './types.js';
import { fhirErrorToReason } from './types.js';

const TOOL_NAME = 'get_recent_labs';

export async function getRecentLabs(
  _params: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  try {
    const bundle = await context.fhirClient.searchBundle<fhir4.Observation>('Observation', {
      patient: context.patientUuid,
      category: 'laboratory',
      _sort: '-date',
      _count: '50',
    });

    const observations = (bundle.entry ?? [])
      .map(e => e.resource)
      .filter((r): r is fhir4.Observation => Boolean(r))
      .filter(r => Boolean(r.effectiveDateTime ?? r.issued));

    // Resolve source-document attribution per row. Best-effort: if the
    // lookup fails or isn't configured, rows fall back to `source: chart`
    // and the citation pill omits the "doc:lab-<id>" attribution.
    const sourceByUuid = await resolveSources(context, observations.map(o => o.id ?? ''));

    const rows: ToolRow[] = observations.map((obs, i) => ({
      id: `tool:${TOOL_NAME}:row-${i}`,
      name: obs.code?.text ?? obs.code?.coding?.[0]?.display ?? null,
      loinc: obs.code?.coding?.find(c => (c.system ?? '').includes('loinc'))?.code ?? null,
      value: obs.valueQuantity?.value ?? obs.valueString ?? null,
      unit: obs.valueQuantity?.unit ?? null,
      date: obs.effectiveDateTime ?? obs.issued ?? null,
      source: sourceByUuid.get(obs.id ?? '') ?? { kind: 'chart' } satisfies SourceAttribution,
    }));

    return { ok: true, rows, tool: TOOL_NAME };
  } catch (err) {
    return { ok: false, reason: fhirErrorToReason(err), tool: TOOL_NAME };
  }
}

async function resolveSources(
  context: ToolContext,
  observationIds: ReadonlyArray<string>,
): Promise<Map<string, SourceAttribution>> {
  const out = new Map<string, SourceAttribution>();
  if (!context.originLookup) return out;
  const refs = observationIds
    .filter(id => id !== '')
    .map(uuid => ({ resourceType: 'procedure_result' as const, uuid }));
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
