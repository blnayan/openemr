import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { LabResultsCard } from '../../src/components/LabResultsCard';
import { FhirClientProvider } from '../../src/fhir/FhirClientProvider';
import { createFhirClientMock } from '../fhirClientMock';
import type { FhirClient } from '../../src/fhir/client';
import type { LabObservationDTO } from '../../src/fhir/schemas/observation';

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

const A1C_HIGH: LabObservationDTO = {
  id: 'o1',
  name: 'Hemoglobin A1c',
  valueDisplay: '7.4 %',
  flag: 'high',
  referenceRange: '4-5.6 %',
  effectiveDateTime: '2024-03-12',
  status: 'final',
};
const LDL_HIGH: LabObservationDTO = {
  id: 'o2',
  name: 'LDL Cholesterol',
  valueDisplay: '158 mg/dL',
  flag: 'high',
  referenceRange: '<= 99 mg/dL',
  effectiveDateTime: '2024-03-10',
  status: 'final',
};
const TSH_NORMAL: LabObservationDTO = {
  id: 'o3',
  name: 'TSH',
  valueDisplay: '2.1 mIU/L',
  flag: 'normal',
  referenceRange: '0.4-4.0 mIU/L',
  effectiveDateTime: '2024-02-20',
  status: 'final',
};
const HGB_LOW: LabObservationDTO = {
  id: 'o4',
  name: 'Hemoglobin',
  valueDisplay: '11.2 g/dL',
  flag: 'low',
  referenceRange: '12-16 g/dL',
  effectiveDateTime: '2024-02-01',
  status: 'final',
};

describe('<LabResultsCard>', () => {
  it('renders the card title', async () => {
    const client = createFhirClientMock({
      fetchObservations: async () => [A1C_HIGH],
    });
    render(
      <Harness client={client}>
        <LabResultsCard patientId={PATIENT_ID} accessToken={TOKEN} />
      </Harness>,
    );
    expect(screen.getByText('Lab Results')).toBeInTheDocument();
    await screen.findByText('Hemoglobin A1c');
  });

  it('renders one row per observation with name + value', async () => {
    const client = createFhirClientMock({
      fetchObservations: async () => [A1C_HIGH, LDL_HIGH, TSH_NORMAL],
    });
    render(
      <Harness client={client}>
        <LabResultsCard patientId={PATIENT_ID} accessToken={TOKEN} />
      </Harness>,
    );

    const list = await screen.findByTestId('lab-results-list');
    const rows = within(list).getAllByTestId('lab-row');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText('Hemoglobin A1c')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('7.4 %')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('LDL Cholesterol')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('158 mg/dL')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('TSH')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('2.1 mIU/L')).toBeInTheDocument();
  });

  it('marks the value with the flagged class on high results, not the row', async () => {
    const client = createFhirClientMock({
      fetchObservations: async () => [A1C_HIGH, TSH_NORMAL],
    });
    render(
      <Harness client={client}>
        <LabResultsCard patientId={PATIENT_ID} accessToken={TOKEN} />
      </Harness>,
    );

    const list = await screen.findByTestId('lab-results-list');
    const rows = within(list).getAllByTestId('lab-row');

    // Row chrome carries no severity class — flagging is value-only.
    expect(rows[0]!.className).not.toMatch(/severe/i);
    expect(rows[0]!.getAttribute('data-flag')).toBe('high');

    // The value span carries the flagged class (red severe color).
    const flaggedValue = within(rows[0]!).getByTestId('lab-value');
    expect(flaggedValue.className).toMatch(/text-severe/);

    // Normal row's value does NOT carry the flagged class.
    const normalValue = within(rows[1]!).getByTestId('lab-value');
    expect(normalValue.className).not.toMatch(/text-severe/);
  });

  it('marks low results with the flagged class on the value', async () => {
    const client = createFhirClientMock({
      fetchObservations: async () => [HGB_LOW],
    });
    render(
      <Harness client={client}>
        <LabResultsCard patientId={PATIENT_ID} accessToken={TOKEN} />
      </Harness>,
    );
    const list = await screen.findByTestId('lab-results-list');
    const row = within(list).getByTestId('lab-row');
    expect(row.getAttribute('data-flag')).toBe('low');
    expect(within(row).getByTestId('lab-value').className).toMatch(
      /text-severe/,
    );
  });

  it('renders effectiveDateTime and reference range on the meta line', async () => {
    const client = createFhirClientMock({
      fetchObservations: async () => [A1C_HIGH],
    });
    render(
      <Harness client={client}>
        <LabResultsCard patientId={PATIENT_ID} accessToken={TOKEN} />
      </Harness>,
    );
    const list = await screen.findByTestId('lab-results-list');
    const row = within(list).getByTestId('lab-row');
    expect(within(row).getByTestId('lab-date').textContent).toBe('2024-03-12');
    expect(within(row).getByTestId('lab-range').textContent).toBe('4-5.6 %');
  });

  it('drops preliminary / entered-in-error rows via the hook filter', async () => {
    // Supply a mix of statuses; the hook's `isReleasedLabResult` should drop
    // everything but final/amended/corrected before the card renders.
    const PRELIM: LabObservationDTO = {
      ...A1C_HIGH,
      id: 'oprelim',
      name: 'Preliminary A1c',
      status: 'preliminary',
    };
    const ERRED: LabObservationDTO = {
      ...A1C_HIGH,
      id: 'oerr',
      name: 'Erred A1c',
      status: 'entered-in-error',
    };
    const client = createFhirClientMock({
      fetchObservations: async () => [A1C_HIGH, PRELIM, ERRED],
    });
    render(
      <Harness client={client}>
        <LabResultsCard patientId={PATIENT_ID} accessToken={TOKEN} />
      </Harness>,
    );
    await screen.findByText('Hemoglobin A1c');
    expect(screen.queryByText('Preliminary A1c')).not.toBeInTheDocument();
    expect(screen.queryByText('Erred A1c')).not.toBeInTheDocument();
  });

  it('sorts results by effectiveDateTime descending (hook sort)', async () => {
    const client = createFhirClientMock({
      fetchObservations: async () => [HGB_LOW, A1C_HIGH, TSH_NORMAL],
    });
    render(
      <Harness client={client}>
        <LabResultsCard patientId={PATIENT_ID} accessToken={TOKEN} />
      </Harness>,
    );
    const list = await screen.findByTestId('lab-results-list');
    const rows = within(list).getAllByTestId('lab-row');
    expect(rows.map((r) => within(r).getByTestId('lab-value').textContent))
      .toEqual([A1C_HIGH.valueDisplay, TSH_NORMAL.valueDisplay, HGB_LOW.valueDisplay]);
  });

  it('renders the "Nothing Recorded" empty state when no labs returned', async () => {
    const client = createFhirClientMock({
      fetchObservations: async () => [],
    });
    render(
      <Harness client={client}>
        <LabResultsCard patientId={PATIENT_ID} accessToken={TOKEN} />
      </Harness>,
    );
    expect(await screen.findByText('Nothing Recorded')).toBeInTheDocument();
  });

  it('renders an in-row error state when the fetch fails', async () => {
    const client = createFhirClientMock({
      fetchObservations: async () => {
        throw new Error('boom');
      },
    });
    render(
      <Harness client={client}>
        <LabResultsCard patientId={PATIENT_ID} accessToken={TOKEN} />
      </Harness>,
    );
    await waitFor(() =>
      expect(
        screen.getByText('Failed to load lab results.'),
      ).toBeInTheDocument(),
    );
  });
});
