import type { ToolContext, ToolResult, ToolRow } from './types.js';
import { fhirErrorToReason } from './types.js';

const TOOL_NAME = 'get_vitals';

export async function getVitals(
  _params: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  try {
    const bundle = await context.fhirClient.searchBundle<fhir4.Observation>('Observation', {
      patient: context.patientUuid,
      category: 'vital-signs',
      _sort: '-date',
      _count: '20',
    });

    const rows: ToolRow[] = (bundle.entry ?? [])
      .map(e => e.resource)
      .filter((r): r is fhir4.Observation => Boolean(r))
      .filter(r => Boolean(r.effectiveDateTime ?? r.issued))
      .map((obs, i) => ({
        id: `tool:${TOOL_NAME}:row-${i}`,
        name: obs.code?.text ?? obs.code?.coding?.[0]?.display ?? null,
        value: obs.valueQuantity?.value ?? obs.valueString ?? null,
        unit: obs.valueQuantity?.unit ?? null,
        date: obs.effectiveDateTime ?? obs.issued ?? null,
        components: (obs.component ?? []).map(c => ({
          name: c.code?.text ?? null,
          value: c.valueQuantity?.value ?? null,
          unit: c.valueQuantity?.unit ?? null,
        })),
      }));

    return { ok: true, rows, tool: TOOL_NAME };
  } catch (err) {
    return { ok: false, reason: fhirErrorToReason(err), tool: TOOL_NAME };
  }
}
