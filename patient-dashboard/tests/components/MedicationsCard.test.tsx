import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { MedicationsCard } from '../../src/components/MedicationsCard';
import { FhirClientProvider } from '../../src/fhir/FhirClientProvider';
import type { FhirClient } from '../../src/fhir/client';
import type { MedicationRequestDTO } from '../../src/fhir/schemas/medicationRequest';

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
  fetchMedicationRequests?: (id: string) => Promise<MedicationRequestDTO[]>,
): FhirClient {
  return {
    fetchPatient: () => {
      throw new Error('not used');
    },
    fetchAllergies: () => {
      throw new Error('not used');
    },
    fetchConditions: () => {
      throw new Error('not used');
    },
    fetchMedicationRequests:
      fetchMedicationRequests
      ?? (() => Promise.resolve<MedicationRequestDTO[]>([])),
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

const LISINOPRIL: MedicationRequestDTO = {
  id: 'm1',
  name: 'Lisinopril 10 MG Oral Tablet',
  dosingText: 'Take 1 tablet by mouth daily',
  status: 'active',
  intent: 'order',
  authoredOn: '2024-02-10',
};
const ATORVASTATIN: MedicationRequestDTO = {
  id: 'm2',
  name: 'Atorvastatin 20 MG',
  dosingText: 'Take 1 tablet at bedtime',
  status: 'active',
  intent: 'order',
  authoredOn: '2023-11-04',
};
const COMPLETED: MedicationRequestDTO = {
  id: 'm3',
  name: 'Amoxicillin 500 MG',
  dosingText: '1 capsule three times daily for 10 days',
  status: 'completed',
  intent: 'order',
  authoredOn: '2022-03-15',
};
const STOPPED: MedicationRequestDTO = {
  id: 'm4',
  name: 'Old Med',
  dosingText: null,
  status: 'stopped',
  intent: 'order',
  authoredOn: null,
};

describe('<MedicationsCard>', () => {
  it('renders the card title and the pencil affordance', async () => {
    const client = buildClient({}, async () => [LISINOPRIL]);
    render(
      <Harness client={client}>
        <MedicationsCard patientId={PATIENT_ID} accessToken={TOKEN} />
      </Harness>,
    );
    expect(screen.getByText('Medications')).toBeInTheDocument();
    expect(screen.getByTestId('medications-edit')).toBeInTheDocument();

    await screen.findByText('Lisinopril 10 MG Oral Tablet');
  });

  it('renders active medications as plain rows with a dosing line', async () => {
    const client = buildClient({}, async () => [LISINOPRIL, ATORVASTATIN]);
    render(
      <Harness client={client}>
        <MedicationsCard patientId={PATIENT_ID} accessToken={TOKEN} />
      </Harness>,
    );

    const list = await screen.findByTestId('medications-list');
    const rows = within(list).getAllByTestId('medication-row');
    expect(rows).toHaveLength(2);
    expect(
      within(rows[0]!).getByText('Lisinopril 10 MG Oral Tablet'),
    ).toBeInTheDocument();
    expect(
      within(rows[0]!).getByText('Take 1 tablet by mouth daily'),
    ).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Atorvastatin 20 MG')).toBeInTheDocument();
    expect(
      within(rows[1]!).getByText('Take 1 tablet at bedtime'),
    ).toBeInTheDocument();
  });

  it('omits the dosing line when dosingText is null', async () => {
    const noDosing: MedicationRequestDTO = {
      ...LISINOPRIL,
      dosingText: null,
    };
    const client = buildClient({}, async () => [noDosing]);
    render(
      <Harness client={client}>
        <MedicationsCard patientId={PATIENT_ID} accessToken={TOKEN} />
      </Harness>,
    );
    await screen.findByText('Lisinopril 10 MG Oral Tablet');
    expect(screen.queryByTestId('medication-dosing')).not.toBeInTheDocument();
  });

  it('filters out non-active medications (hook drops completed/stopped)', async () => {
    const client = buildClient({}, async () => [
      LISINOPRIL,
      COMPLETED,
      STOPPED,
    ]);
    render(
      <Harness client={client}>
        <MedicationsCard patientId={PATIENT_ID} accessToken={TOKEN} />
      </Harness>,
    );
    await screen.findByText('Lisinopril 10 MG Oral Tablet');
    expect(screen.queryByText('Amoxicillin 500 MG')).not.toBeInTheDocument();
    expect(screen.queryByText('Old Med')).not.toBeInTheDocument();
  });

  it('renders the "Nothing Recorded" empty state when no meds returned', async () => {
    const client = buildClient({}, async () => []);
    render(
      <Harness client={client}>
        <MedicationsCard patientId={PATIENT_ID} accessToken={TOKEN} />
      </Harness>,
    );
    expect(await screen.findByText('Nothing Recorded')).toBeInTheDocument();
  });

  it('renders the empty state when every medication is filtered out', async () => {
    const client = buildClient({}, async () => [COMPLETED, STOPPED]);
    render(
      <Harness client={client}>
        <MedicationsCard patientId={PATIENT_ID} accessToken={TOKEN} />
      </Harness>,
    );
    expect(await screen.findByText('Nothing Recorded')).toBeInTheDocument();
  });

  it('renders an in-row error state when the fetch fails', async () => {
    const client = buildClient({}, async () => {
      throw new Error('boom');
    });
    render(
      <Harness client={client}>
        <MedicationsCard patientId={PATIENT_ID} accessToken={TOKEN} />
      </Harness>,
    );
    await waitFor(() =>
      expect(
        screen.getByText('Failed to load medications.'),
      ).toBeInTheDocument(),
    );
  });
});
