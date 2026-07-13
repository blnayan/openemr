import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { AllergiesCard } from '../../src/components/AllergiesCard';
import { FhirClientProvider } from '../../src/fhir/FhirClientProvider';
import type { FhirClient } from '../../src/fhir/client';
import type { AllergyDTO } from '../../src/fhir/schemas/allergyIntolerance';

const PATIENT_ID = 'margaret-uuid';
const TOKEN = 'tok-abc';

interface HarnessOptions {
  client: FhirClient;
}

function Harness({
  client,
  children,
}: HarnessOptions & { children: ReactNode }): React.JSX.Element {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>
      <FhirClientProvider accessToken={TOKEN} client={client}>
        {children}
      </FhirClientProvider>
    </QueryClientProvider>
  );
}

function buildClient(
  overrides: Partial<FhirClient> = {},
  fetchAllergies?: (id: string) => Promise<AllergyDTO[]>,
): FhirClient {
  return {
    fetchPatient: () => {
      throw new Error('not used');
    },
    fetchAllergies:
      fetchAllergies
      ?? (() => Promise.resolve<AllergyDTO[]>([])),
    fetchConditions: () => {
      throw new Error('not used');
    },
    fetchMedicationRequests: () => {
      throw new Error('not used');
    },
    fetchCareTeam: () => {
      throw new Error('not used');
    },
    fetchObservations: () => {
      throw new Error('not used');
    },
    fetchBundle: () => {
      throw new Error('not used');
    },
    ...overrides,
  };
}

const PENICILLIN: AllergyDTO = {
  id: 'a1',
  name: 'Penicillin',
  criticality: 'high',
  reactionSeverity: 'severe',
  clinicalStatus: 'active',
};
const SULFA: AllergyDTO = {
  id: 'a2',
  name: 'Sulfa drugs',
  criticality: 'low',
  reactionSeverity: 'mild',
  clinicalStatus: 'active',
};
const SHELLFISH: AllergyDTO = {
  id: 'a3',
  name: 'Shellfish',
  criticality: 'unable-to-assess',
  reactionSeverity: null,
  clinicalStatus: 'active',
};
const RESOLVED: AllergyDTO = {
  id: 'a4',
  name: 'Old amoxicillin allergy',
  criticality: 'high',
  reactionSeverity: 'severe',
  clinicalStatus: 'resolved',
};

describe('<AllergiesCard>', () => {
  it('renders the card title and the pencil affordance', async () => {
    const client = buildClient({}, async () => [PENICILLIN]);
    render(
      <Harness client={client}>
        <AllergiesCard patientId={PATIENT_ID} accessToken={TOKEN} />
      </Harness>,
    );
    expect(screen.getByText('Allergies')).toBeInTheDocument();
    // Pencil glyph is purely visual in this slice (#31 wires it up).
    expect(screen.getByTestId('allergies-edit')).toBeInTheDocument();

    await screen.findByText('Penicillin');
  });

  it('renders rows with severity-tinted backgrounds per row', async () => {
    const client = buildClient({}, async () => [PENICILLIN, SULFA, SHELLFISH]);
    render(
      <Harness client={client}>
        <AllergiesCard patientId={PATIENT_ID} accessToken={TOKEN} />
      </Harness>,
    );

    const list = await screen.findByTestId('allergies-list');
    const rows = within(list).getAllByTestId('allergy-row');
    expect(rows).toHaveLength(3);

    expect(rows[0]).toHaveAttribute('data-severity', 'moderate');
    expect(rows[1]).toHaveAttribute('data-severity', 'mild');
    expect(rows[2]).toHaveAttribute('data-severity', 'unknown');

    expect(within(rows[0]!).getByText('Penicillin')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Moderate')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Mild')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Unknown')).toBeInTheDocument();
  });

  it('filters out resolved allergies (the hook drops non-active rows)', async () => {
    const client = buildClient({}, async () => [PENICILLIN, RESOLVED]);
    render(
      <Harness client={client}>
        <AllergiesCard patientId={PATIENT_ID} accessToken={TOKEN} />
      </Harness>,
    );
    await screen.findByText('Penicillin');
    expect(screen.queryByText('Old amoxicillin allergy')).not.toBeInTheDocument();
  });

  it('renders the No-Known-Allergies empty state', async () => {
    const client = buildClient({}, async () => []);
    render(
      <Harness client={client}>
        <AllergiesCard patientId={PATIENT_ID} accessToken={TOKEN} />
      </Harness>,
    );
    expect(await screen.findByText('No Known Allergies')).toBeInTheDocument();
  });

  it('renders an in-row error state when the fetch fails', async () => {
    const client = buildClient({}, async () => {
      throw new Error('boom');
    });
    render(
      <Harness client={client}>
        <AllergiesCard patientId={PATIENT_ID} accessToken={TOKEN} />
      </Harness>,
    );
    await waitFor(() =>
      expect(screen.getByText('Failed to load allergies.')).toBeInTheDocument(),
    );
  });
});
