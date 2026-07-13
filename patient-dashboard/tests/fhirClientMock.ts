/**
 * Shared partial-mock helper for `FhirClient` test stubs.
 *
 * Card tests historically open-coded a `buildClient(overrides, primaryFn)`
 * helper that stubbed every other method with `() => { throw new Error('not used'); }`.
 * That was workable at three methods, became friction at five, and is friction
 * worth removing at six (#30 adds `fetchObservations`). This helper centralizes
 * the throw-stub default so a new method only needs adding once here, not in
 * every card test.
 *
 * Pattern:
 *
 *   const client = createFhirClientMock({
 *     fetchAllergies: async () => [PENICILLIN],
 *   });
 *
 * Methods you don't override throw `'not used'` if the code under test
 * accidentally calls them — this is intentional, since a card test that
 * triggers another card's fetch should fail loudly, not silently return [].
 */

import type { FhirClient } from '../src/fhir/client';

export function createFhirClientMock(
  overrides: Partial<FhirClient> = {},
): FhirClient {
  const notUsed = (name: string) => () => {
    throw new Error(`FhirClient.${name} called but not stubbed in this test`);
  };
  return {
    fetchPatient: notUsed('fetchPatient'),
    fetchAllergies: notUsed('fetchAllergies'),
    fetchConditions: notUsed('fetchConditions'),
    fetchMedicationRequests: notUsed('fetchMedicationRequests'),
    fetchCareTeam: notUsed('fetchCareTeam'),
    fetchObservations: notUsed('fetchObservations'),
    fetchBundle: notUsed('fetchBundle'),
    ...overrides,
  };
}
