/**
 * TanStack Query hook for the bound patient.
 *
 * Disabled while the OAuth access token or patient claim is still null, so
 * we never issue an unauthenticated FHIR request. Future card hooks
 * (`useAllergies`, `useConditions`, …) follow the same pattern: `enabled`
 * gates on `accessToken !== null && patientId !== null`.
 */

import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { useFhirClient } from '../FhirClientProvider';
import type { PatientDTO } from '../schemas/patient';

export function usePatient(
  patientId: string | null,
  accessToken: string | null,
): UseQueryResult<PatientDTO, Error> {
  const client = useFhirClient();

  return useQuery<PatientDTO, Error>({
    queryKey: ['patient', patientId],
    queryFn: () => {
      if (patientId === null) {
        throw new Error('usePatient called without a patientId');
      }
      return client.fetchPatient(patientId);
    },
    enabled: patientId !== null && accessToken !== null,
    // FHIR resources don't change frequently within a single visit; we
    // refetch on mount but leave window-focus refetch on the default. This
    // is a sensible starting point — subsequent slices may tune per resource.
    staleTime: 60_000,
  });
}
