import type { ToolContext, ToolResult, ToolRow } from './types.js';
import { fhirErrorToReason } from './types.js';

const TOOL_NAME = 'get_active_problems';

export async function getActiveProblems(
  _params: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  try {
    // OpenEMR's FHIR Condition endpoint does not accept a clinical-status
    // search parameter (returns HTTP 400). Fetch all Conditions and filter
    // active ones in memory.
    const bundle = await context.fhirClient.searchBundle<fhir4.Condition>('Condition', {
      patient: context.patientUuid,
    });

    const rows: ToolRow[] = (bundle.entry ?? [])
      .map(e => e.resource)
      .filter((r): r is fhir4.Condition => Boolean(r))
      .filter(cond => {
        const codings = cond.clinicalStatus?.coding ?? [];
        if (codings.length === 0) return true; // missing → treat as active (AUDIT.md §4)
        return codings.some(c => (c.code ?? '').toLowerCase() === 'active' || (c.code ?? '').toLowerCase() === 'recurrence' || (c.code ?? '').toLowerCase() === 'relapse');
      })
      .map((cond, i) => {
        const isActive = cond.clinicalStatus === undefined
          || (cond.clinicalStatus.coding ?? []).some(c => c.code === 'active' || c.code === undefined);
        return {
          id: `tool:${TOOL_NAME}:row-${i}`,
          condition: cond.code?.text ?? cond.code?.coding?.[0]?.display ?? null,
          icd10: cond.code?.coding?.find(c => (c.system ?? '').includes('icd-10'))?.code ?? null,
          onset: cond.onsetDateTime ?? null,
          active: isActive,
        };
      });

    return { ok: true, rows, tool: TOOL_NAME };
  } catch (err) {
    return { ok: false, reason: fhirErrorToReason(err), tool: TOOL_NAME };
  }
}
