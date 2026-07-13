import type { ToolContext, ToolResult, ToolRow } from './types.js';
import { fhirErrorToReason } from './types.js';

const TOOL_NAME = 'get_patient_summary';

export async function getPatientSummary(
  _params: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  try {
    const patient = await context.fhirClient.getPatient(context.patientUuid);

    const givenName = patient.name?.[0]?.given?.[0] ?? null;
    const familyName = patient.name?.[0]?.family ?? null;
    const sex = patient.gender ? String(patient.gender).toLowerCase() : null;
    const dob = patient.birthDate ?? null;

    const row: ToolRow = {
      id: `tool:${TOOL_NAME}:row-0`,
      patient_uuid: context.patientUuid,
      given_name: givenName,
      family_name: familyName,
      sex,
      dob,
    };

    return { ok: true, rows: [row], tool: TOOL_NAME };
  } catch (err) {
    return { ok: false, reason: fhirErrorToReason(err), tool: TOOL_NAME };
  }
}
