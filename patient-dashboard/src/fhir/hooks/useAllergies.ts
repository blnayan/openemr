/**
 * TanStack Query hook for the bound patient's allergies.
 *
 * Filters resolved/inactive entries here (not in the schema layer) so the
 * raw DTO shape stays a faithful projection of FHIR while the *card-facing*
 * data is policy-correct. The card never sees archived allergies — they
 * pollute the safety signal.
 *
 * Disabled while the OAuth access token or patient id is null, mirroring
 * `usePatient`. Stale time matches `usePatient` (60s).
 */

import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { useFhirClient } from '../FhirClientProvider';
import type { AllergyDTO } from '../schemas/allergyIntolerance';

export function useAllergies(
  patientId: string | null,
  accessToken: string | null,
): UseQueryResult<AllergyDTO[], Error> {
  const client = useFhirClient();

  return useQuery<AllergyDTO[], Error>({
    queryKey: ['allergies', patientId],
    queryFn: async () => {
      if (patientId === null) {
        throw new Error('useAllergies called without a patientId');
      }
      const all = await client.fetchAllergies(patientId);
      // Treat 'resolved' and 'inactive' as out-of-scope for the dashboard
      // card. Null clinicalStatus is treated as active because legacy
      // OpenEMR rows predate clinical-status tracking and are still real
      // allergies the clinician needs to see.
      return all.filter((a) => {
        if (a.clinicalStatus === null) {
          return true;
        }
        return a.clinicalStatus === 'active';
      });
    },
    enabled: patientId !== null && accessToken !== null,
    staleTime: 60_000,
  });
}
