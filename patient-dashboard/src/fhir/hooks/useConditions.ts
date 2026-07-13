/**
 * TanStack Query hook for the bound patient's conditions (Medical Problems).
 *
 * Filter policy (this hook is the only place it lives):
 *
 *   1. clinicalStatus: keep `active`, `recurrence`, `relapse` (and null —
 *      legacy OpenEMR rows predate clinical-status tracking and are still
 *      real problems the clinician needs to see). Drop `inactive`,
 *      `resolved`, `remission`.
 *   2. verificationStatus: drop `refuted` and `entered-in-error`. All other
 *      verification states (confirmed / unconfirmed / provisional /
 *      differential / null) pass through — clinicians need to see
 *      provisional / unconfirmed problems on the dashboard.
 *
 * Disabled while the OAuth access token or patient id is null, mirroring
 * `usePatient` / `useAllergies`. Stale time matches the other clinical
 * hooks (60s).
 */

import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { useFhirClient } from '../FhirClientProvider';
import type { ConditionDTO } from '../schemas/condition';

const ACTIVE_CLINICAL_STATUSES: ReadonlySet<string> = new Set([
  'active',
  'recurrence',
  'relapse',
]);

const DROPPED_VERIFICATION_STATUSES: ReadonlySet<string> = new Set([
  'refuted',
  'entered-in-error',
]);

/**
 * Pure filter — exported for direct testing. Returns `true` when the
 * condition should appear on the dashboard's Medical Problems card.
 */
export function isActiveProblem(c: ConditionDTO): boolean {
  if (
    c.verificationStatus !== null
    && DROPPED_VERIFICATION_STATUSES.has(c.verificationStatus)
  ) {
    return false;
  }
  if (c.clinicalStatus === null) {
    return true;
  }
  return ACTIVE_CLINICAL_STATUSES.has(c.clinicalStatus);
}

export function useConditions(
  patientId: string | null,
  accessToken: string | null,
): UseQueryResult<ConditionDTO[], Error> {
  const client = useFhirClient();

  return useQuery<ConditionDTO[], Error>({
    queryKey: ['conditions', patientId],
    queryFn: async () => {
      if (patientId === null) {
        throw new Error('useConditions called without a patientId');
      }
      const all = await client.fetchConditions(patientId);
      return all.filter(isActiveProblem);
    },
    enabled: patientId !== null && accessToken !== null,
    staleTime: 60_000,
  });
}
