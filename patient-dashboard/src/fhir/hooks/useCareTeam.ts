/**
 * TanStack Query hook for the bound patient's Care Team participants.
 *
 * Filter policy (this hook is the only place it lives):
 *
 *   - Keep `status === 'active'` and `status === null` (legacy OpenEMR rows
 *     predate CareTeam status tracking and still represent real care
 *     relationships the clinician needs to see). Drop `'inactive'`,
 *     `'entered-in-error'`, and `'suspended'`.
 *
 * Disabled while the OAuth access token or patient id is null, mirroring the
 * other clinical hooks. Stale time matches the other clinical hooks (60s).
 */

import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { useFhirClient } from '../FhirClientProvider';
import type { CareTeamParticipantDTO } from '../schemas/careTeam';

const DROPPED_STATUSES: ReadonlySet<string> = new Set([
  'inactive',
  'entered-in-error',
  'suspended',
]);

/**
 * Pure filter — exported for direct testing. Returns `true` when the
 * participant should appear on the dashboard's Care Team card.
 */
export function isActiveCareTeamParticipant(
  p: CareTeamParticipantDTO,
): boolean {
  if (p.status === null) {
    return true;
  }
  return !DROPPED_STATUSES.has(p.status);
}

export function useCareTeam(
  patientId: string | null,
  accessToken: string | null,
): UseQueryResult<CareTeamParticipantDTO[], Error> {
  const client = useFhirClient();

  return useQuery<CareTeamParticipantDTO[], Error>({
    queryKey: ['careTeam', patientId],
    queryFn: async () => {
      if (patientId === null) {
        throw new Error('useCareTeam called without a patientId');
      }
      const all = await client.fetchCareTeam(patientId);
      return all.filter(isActiveCareTeamParticipant);
    },
    enabled: patientId !== null && accessToken !== null,
    staleTime: 60_000,
  });
}
