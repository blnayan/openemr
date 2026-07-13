import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { ProblemsCard } from '../../src/components/ProblemsCard';
import { FhirClientProvider } from '../../src/fhir/FhirClientProvider';
import type { FhirClient } from '../../src/fhir/client';
import type { ConditionDTO } from '../../src/fhir/schemas/condition';

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
  fetchConditions?: (id: string) => Promise<ConditionDTO[]>,
): FhirClient {
  return {
    fetchPatient: () => {
      throw new Error('not used');
    },
    fetchAllergies: () => {
      throw new Error('not used');
    },
    fetchConditions:
      fetchConditions
      ?? (() => Promise.resolve<ConditionDTO[]>([])),
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

const HYPERTENSION: ConditionDTO = {
  id: 'c1',
  name: 'Hypertension',
  clinicalStatus: 'active',
  verificationStatus: 'confirmed',
  recordedDate: '2024-01-15',
};
const DIABETES: ConditionDTO = {
  id: 'c2',
  name: 'Type 2 diabetes',
  clinicalStatus: 'active',
  verificationStatus: 'confirmed',
  recordedDate: '2023-05-02',
};
const RESOLVED: ConditionDTO = {
  id: 'c3',
  name: 'Old ear infection',
  clinicalStatus: 'resolved',
  verificationStatus: 'confirmed',
  recordedDate: '2020-04-01',
};
const REFUTED: ConditionDTO = {
  id: 'c4',
  name: 'Refuted ulcer',
  clinicalStatus: 'active',
  verificationStatus: 'refuted',
  recordedDate: null,
};

describe('<ProblemsCard>', () => {
  it('renders the card title and the pencil affordance', async () => {
    const client = buildClient({}, async () => [HYPERTENSION]);
    render(
      <Harness client={client}>
        <ProblemsCard patientId={PATIENT_ID} accessToken={TOKEN} />
      </Harness>,
    );
    expect(screen.getByText('Medical Problems')).toBeInTheDocument();
    expect(screen.getByTestId('problems-edit')).toBeInTheDocument();

    await screen.findByText('Hypertension');
  });

  it('renders active conditions as plain rows', async () => {
    const client = buildClient({}, async () => [HYPERTENSION, DIABETES]);
    render(
      <Harness client={client}>
        <ProblemsCard patientId={PATIENT_ID} accessToken={TOKEN} />
      </Harness>,
    );

    const list = await screen.findByTestId('problems-list');
    const rows = within(list).getAllByTestId('problem-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('Hypertension')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Type 2 diabetes')).toBeInTheDocument();
  });

  it('filters out resolved and refuted conditions (hook drops non-active rows)', async () => {
    const client = buildClient({}, async () => [
      HYPERTENSION,
      RESOLVED,
      REFUTED,
    ]);
    render(
      <Harness client={client}>
        <ProblemsCard patientId={PATIENT_ID} accessToken={TOKEN} />
      </Harness>,
    );
    await screen.findByText('Hypertension');
    expect(screen.queryByText('Old ear infection')).not.toBeInTheDocument();
    expect(screen.queryByText('Refuted ulcer')).not.toBeInTheDocument();
  });

  it('renders the "Nothing Recorded" empty state', async () => {
    const client = buildClient({}, async () => []);
    render(
      <Harness client={client}>
        <ProblemsCard patientId={PATIENT_ID} accessToken={TOKEN} />
      </Harness>,
    );
    expect(await screen.findByText('Nothing Recorded')).toBeInTheDocument();
  });

  it('renders the empty state when every condition is filtered out', async () => {
    const client = buildClient({}, async () => [RESOLVED, REFUTED]);
    render(
      <Harness client={client}>
        <ProblemsCard patientId={PATIENT_ID} accessToken={TOKEN} />
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
        <ProblemsCard patientId={PATIENT_ID} accessToken={TOKEN} />
      </Harness>,
    );
    await waitFor(() =>
      expect(screen.getByText('Failed to load problems.')).toBeInTheDocument(),
    );
  });

  it('falls back to "(unnamed condition)" when a row has no name', async () => {
    const unnamed: ConditionDTO = {
      id: 'c-x',
      name: '',
      clinicalStatus: 'active',
      verificationStatus: 'confirmed',
      recordedDate: null,
    };
    const client = buildClient({}, async () => [unnamed]);
    render(
      <Harness client={client}>
        <ProblemsCard patientId={PATIENT_ID} accessToken={TOKEN} />
      </Harness>,
    );
    expect(await screen.findByText('(unnamed condition)')).toBeInTheDocument();
  });
});
