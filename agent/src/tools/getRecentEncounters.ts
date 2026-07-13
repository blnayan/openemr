/**
 * getRecentEncounters — last 10 encounters for the patient. Used by
 * the planner to seed answers with "what changed since last visit"
 * context, which is the dashboard mount's primary use case (UC-1).
 */

import type { ToolContext, ToolResult, ToolRow } from './types.js';
import { fhirErrorToReason } from './types.js';

const TOOL_NAME = 'get_recent_encounters';

export async function getRecentEncounters(
  _params: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  try {
    const bundle = await context.fhirClient.searchBundle<fhir4.Encounter>('Encounter', {
      patient: context.patientUuid,
      _sort: '-date',
      _count: '10',
    });

    const rows: ToolRow[] = (bundle.entry ?? [])
      .map(e => e.resource)
      .filter((r): r is fhir4.Encounter => Boolean(r))
      .map((enc, i) => ({
        id: `tool:${TOOL_NAME}:row-${i}`,
        encounter_id: enc.id ?? null,
        class: enc.class?.display ?? enc.class?.code ?? null,
        type: enc.type?.[0]?.text ?? enc.type?.[0]?.coding?.[0]?.display ?? null,
        reason: enc.reasonCode?.[0]?.text ?? null,
        start: enc.period?.start ?? null,
        end: enc.period?.end ?? null,
        status: enc.status ?? null,
      }));

    return { ok: true, rows, tool: TOOL_NAME };
  } catch (err) {
    return { ok: false, reason: fhirErrorToReason(err), tool: TOOL_NAME };
  }
}
