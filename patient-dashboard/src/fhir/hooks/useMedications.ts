/**
 * TanStack Query hook for the bound patient's active medications.
 *
 * Filter policy (this hook is the only place it lives):
 *
 *   1. status: keep only `active`. Drop everything else (`on-hold`,
 *      `cancelled`, `completed`, `entered-in-error`, `stopped`, `draft`,
 *      `unknown`). Also drop rows with `null` status — unlike Conditions,
 *      where legacy rows predate clinical-status tracking, MedicationRequest
 *      `status` is required by FHIR R4 and OpenEMR consistently emits it,
 *      so a missing status is a data-quality issue, not a legacy artifact.
 *
 * Cache strategy (B): the underlying query is keyed on
 * `['medicationRequests', patientId]` and feeds *both* this hook and
 * `usePrescriptions` (#28). Each hook applies its own filter via
 * TanStack `select`, so one network round trip serves two cards.
 * `useMedications` keeps its public name (callers untouched) but no longer
 * owns the cache entry — it shares it with `usePrescriptions`.
 *
 * Why `select` instead of two `queryFn`s with the same key? `select` runs on
 * the cached data without re-fetching, and TanStack memoizes per-component
 * so each card only re-renders when its filtered slice actually changes.
 *
 * Disabled while the OAuth access token or patient id is null, mirroring
 * `usePatient` / `useAllergies` / `useConditions`. Stale time matches the
 * other clinical hooks (60s).
 */

import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { useFhirClient } from '../FhirClientProvider';
import type { MedicationRequestDTO } from '../schemas/medicationRequest';

/**
 * Pure filter — exported for direct testing. Returns `true` when the
 * medication should appear on the dashboard's Medications card.
 */
export function isActiveMedication(m: MedicationRequestDTO): boolean {
  return m.status === 'active';
}

/**
 * Shared query key used by both `useMedications` and `usePrescriptions` so
 * the underlying `MedicationRequest` bundle is fetched once and filtered
 * twice (see strategy (B) note above).
 */
export function medicationRequestsQueryKey(
  patientId: string | null,
): readonly ['medicationRequests', string | null] {
  return ['medicationRequests', patientId] as const;
}

export function useMedications(
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
        throw new Error('useMedications called without a patientId');
      }
      return client.fetchMedicationRequests(patientId);
    },
    select: (all) => all.filter(isActiveMedication),
    enabled: patientId !== null && accessToken !== null,
    staleTime: 60_000,
  });
}
