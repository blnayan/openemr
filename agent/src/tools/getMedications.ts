/**
 * getMedications — active prescriptions only. AUDIT.md §4 calls out a
 * data-quality cliff in the upstream `prescriptions` table: rows with
 * active=1 AND end_date < now() are still returned by FHIR. We filter
 * those out at the tool layer.
 */

import type { ToolContext, ToolResult, ToolRow, SourceAttribution } from './types.js';
import { fhirErrorToReason } from './types.js';

const TOOL_NAME = 'get_medications';
const RXNORM_SYSTEM = 'http://www.nlm.nih.gov/research/umls/rxnorm';

export async function getMedications(
  _params: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  try {
    const bundle = await context.fhirClient.searchBundle<fhir4.MedicationRequest>(
      'MedicationRequest',
      {
        patient: context.patientUuid,
        status: 'active',
      },
    );

    if (bundle?.resourceType !== 'Bundle') {
      const oo = (bundle as unknown) as { resourceType?: string };
      const reason = oo?.resourceType === 'OperationOutcome'
        ? 'fhir_404_not_found'
        : 'fhir_unexpected_response';
      return { ok: false, reason, tool: TOOL_NAME };
    }

    const now = Date.now();
    const kept: fhir4.MedicationRequest[] = [];

    for (const entry of bundle.entry ?? []) {
      const med = entry.resource;
      if (!med) continue;

      const endRaw = med.dispenseRequest?.validityPeriod?.end ?? null;
      if (typeof endRaw === 'string' && endRaw !== '') {
        const endTs = Date.parse(endRaw);
        if (!Number.isNaN(endTs) && endTs < now) {
          continue;
        }
      }
      kept.push(med);
    }

    // FHIR MedicationRequest resources are backed by `lists` rows with
    // type='medication' in OpenEMR; the resource id IS the lists.uuid,
    // so the IntakeWriter's `lists.source_document_id` stamp is what
    // SidecarOriginLookup resolves here.
    const sourceByUuid = await resolveSources(context, kept.map(m => m.id ?? ''));

    const rows: ToolRow[] = kept.map((med, i) => {
      const rxnormCoding = (med.medicationCodeableConcept?.coding ?? [])
        .find(c => c.system === RXNORM_SYSTEM);

      const drugName = med.medicationCodeableConcept?.text
        ?? med.medicationCodeableConcept?.coding?.[0]?.display
        ?? null;

      const dosageText = med.dosageInstruction?.[0]?.text ?? null;
      const doseQty = med.dosageInstruction?.[0]?.doseAndRate?.[0]?.doseQuantity;
      const doseMg = (doseQty?.unit ?? '').toLowerCase().includes('mg')
        ? Number(doseQty?.value ?? NaN)
        : null;

      return {
        id: `tool:${TOOL_NAME}:row-${i}`,
        drug_name: drugName,
        rxnorm_code: rxnormCoding?.code ?? null,
        dosage: dosageText,
        dose_mg: Number.isFinite(doseMg) ? doseMg : null,
        end_date: med.dispenseRequest?.validityPeriod?.end ?? null,
        status: med.status ?? 'active',
        source: sourceByUuid.get(med.id ?? '') ?? { kind: 'chart' } satisfies SourceAttribution,
      };
    });

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
