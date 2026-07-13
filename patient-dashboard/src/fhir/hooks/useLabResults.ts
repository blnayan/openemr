/**
 * TanStack Query hook for the bound patient's recent lab results.
 *
 * Filter policy (this hook is the only place it lives):
 *
 *   - Keep `status ∈ {'final', 'amended', 'corrected'}` and null status
 *     (legacy parity with the other clinical hooks). Drop `'preliminary'`
 *     (provisional reads not yet released to the patient record),
 *     `'cancelled'`, `'entered-in-error'`, and `'registered'` (placeholder
 *     stub before any value lands).
 *
 * Sort policy: results are returned to the card sorted by
 * `effectiveDateTime` descending (newest first), with rows missing
 * `effectiveDateTime` sinking to the bottom. The FHIR server *usually*
 * returns this order, but we sort client-side defensively because the spec
 * doesn't guarantee it and OpenEMR's index ordering changes between releases.
 *
 * Disabled while the OAuth access token or patient id is null, mirroring the
 * other clinical hooks. Stale time matches the other clinical hooks (60s).
 */

import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { useFhirClient } from '../FhirClientProvider';
import type { LabObservationDTO } from '../schemas/observation';

const KEPT_STATUSES: ReadonlySet<string> = new Set([
  'final',
  'amended',
  'corrected',
]);

/**
 * Pure filter — exported for direct testing. Returns `true` when the
 * observation should appear on the dashboard's Lab Results card.
 */
export function isReleasedLabResult(o: LabObservationDTO): boolean {
  if (o.status === null) {
    return true;
  }
  return KEPT_STATUSES.has(o.status);
}

/**
 * Pure comparator — exported for direct testing. Sorts by
 * `effectiveDateTime` descending (newest first); rows with null dates sink
 * to the end. We compare the raw ISO strings directly: ISO-8601 sorts
 * lexicographically the same way it sorts chronologically, so we sidestep
 * the `new Date('YYYY-MM-DD')` UTC-vs-local trap (see CLAUDE.md gotcha).
 */
export function compareByEffectiveDateDesc(
  a: LabObservationDTO,
  b: LabObservationDTO,
): number {
  if (a.effectiveDateTime === null && b.effectiveDateTime === null) {
    return 0;
  }
  if (a.effectiveDateTime === null) {
    return 1;
  }
  if (b.effectiveDateTime === null) {
    return -1;
  }
  if (a.effectiveDateTime > b.effectiveDateTime) {
    return -1;
  }
  if (a.effectiveDateTime < b.effectiveDateTime) {
    return 1;
  }
  return 0;
}

export function useLabResults(
  patientId: string | null,
  accessToken: string | null,
): UseQueryResult<LabObservationDTO[], Error> {
  const client = useFhirClient();

  return useQuery<LabObservationDTO[], Error>({
    queryKey: ['labResults', patientId],
    queryFn: async () => {
      if (patientId === null) {
        throw new Error('useLabResults called without a patientId');
      }
      const all = await client.fetchObservations(patientId, 'laboratory');
      return all.filter(isReleasedLabResult).sort(compareByEffectiveDateDesc);
    },
    enabled: patientId !== null && accessToken !== null,
    staleTime: 60_000,
  });
}
