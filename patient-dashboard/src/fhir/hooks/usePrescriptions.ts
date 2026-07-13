/**
 * TanStack Query hook for the bound patient's active *prescription orders*.
 *
 * OpenEMR's FHIR server does not implement `MedicationStatement`, so both
 * the Medications and Prescriptions cards are backed by the same underlying
 * `MedicationRequest` resource. The two hooks differ only in their filter:
 *
 *   - `useMedications` keeps `status === 'active'`.
 *   - `usePrescriptions` (this hook) additionally narrows by `intent` to the
 *     "order" family, distinguishing actual prescription orders from
 *     proposals / plans / options.
 *
 * Cache strategy (B): both hooks share the query key
 * `['medicationRequests', patientId]`, so the network round trip happens
 * exactly once per patient. Each hook applies its own `select` to filter.
 * See `useMedications.ts` for the full rationale.
 *
 * Caveat: in OpenEMR's seeded data the two cards may end up identical (the
 * legacy `medication.html.twig` and `rx.html.twig` views essentially mirror
 * one another). That's expected for the v1 ship; the conceptual distinction
 * is preserved at the title level even when the row sets coincide.
 *
 * Disabled while the OAuth access token or patient id is null, mirroring
 * the other clinical hooks. Stale time matches at 60s.
 */

import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { useFhirClient } from '../FhirClientProvider';
import type { MedicationRequestDTO } from '../schemas/medicationRequest';
import { medicationRequestsQueryKey } from './useMedications';

/**
 * FHIR R4 `MedicationRequest.intent` values that represent an actual
 * prescription order (as opposed to a plan / proposal / option). Sourced
 * from https://hl7.org/fhir/R4/valueset-medicationrequest-intent.html.
 */
const ORDER_INTENTS: ReadonlySet<string> = new Set([
  'order',
  'original-order',
  'reflex-order',
  'filler-order',
  'instance-order',
]);

/**
 * Pure filter — exported for direct testing. Returns `true` when the
 * medication should appear on the dashboard's Prescriptions card: it must
 * be `active` *and* carry an order-family intent. Rows with a `null` intent
 * are dropped; the Prescriptions card is intent-driven by definition.
 */
export function isActivePrescription(m: MedicationRequestDTO): boolean {
  if (m.status !== 'active') {
    return false;
  }
  if (m.intent === null) {
    return false;
  }
  return ORDER_INTENTS.has(m.intent);
}

export function usePrescriptions(
  patientId: string | null,
  accessToken: string | null,
): UseQueryResult<MedicationRequestDTO[], Error> {
  const client = useFhirClient();

  return useQuery<
    MedicationRequestDTO[],
    Error,
    MedicationRequestDTO[]
  >({
    queryKey: medicationRequestsQueryKey(patientId),
    queryFn: async () => {
      if (patientId === null) {
        throw new Error('usePrescriptions called without a patientId');
      }
      return client.fetchMedicationRequests(patientId);
    },
    select: (all) => all.filter(isActivePrescription),
    enabled: patientId !== null && accessToken !== null,
    staleTime: 60_000,
  });
}
