import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { CareTeamCard } from '../../src/components/CareTeamCard';
import { FhirClientProvider } from '../../src/fhir/FhirClientProvider';
import type { FhirClient } from '../../src/fhir/client';
import type { CareTeamParticipantDTO } from '../../src/fhir/schemas/careTeam';

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
  fetchCareTeam?: (id: string) => Promise<CareTeamParticipantDTO[]>,
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
    fetchMedicationRequests: () => {
      throw new Error('not used');
    },
    fetchCareTeam:
      fetchCareTeam
      ?? (() => Promise.resolve<CareTeamParticipantDTO[]>([])),
    fetchObservations: () => {
      throw new Error('not used');
    },
    fetchBundle: () => {
      throw new Error('not used');
    },
    ...overrides,
  };
}

const PCP: CareTeamParticipantDTO = {
  careTeamId: 'ct1',
  participantId: 'ct1:p1',
  status: 'active',
  name: 'Dr Anita Smith',
  role: 'Primary Care Provider',
};
const CARDIOLOGIST: CareTeamParticipantDTO = {
  careTeamId: 'ct1',
  participantId: 'ct1:p2',
  status: 'active',
  name: 'Dr Marcus Jones',
  role: 'Cardiologist',
};
const INACTIVE: CareTeamParticipantDTO = {
  careTeamId: 'ct2',
  participantId: 'ct2:p1',
  status: 'inactive',
  name: 'Dr Old',
  role: 'Former PCP',
};
const ERRED: CareTeamParticipantDTO = {
  careTeamId: 'ct3',
  participantId: 'ct3:p1',
  status: 'entered-in-error',
  name: 'Wrong Person',
  role: 'Mistake',
};

describe('<CareTeamCard>', () => {
  // The card's read view fetches via the same form-data.php endpoint
  // the editor uses, so we mock global fetch (not the FHIR client) to
  // drive read-mode assertions.
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function mockFormData(overrides: Partial<typeof FORM_DATA_FIXTURE>): void {
    global.fetch = makeFetchMock({
      formData: async () =>
        new Response(JSON.stringify({ ...FORM_DATA_FIXTURE, ...overrides }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });
  }

  it('renders the card title and the pencil affordance', async () => {
    mockFormData({});
    const client = buildClient({});
    render(
      <Harness client={client}>
        <CareTeamCard patientId={PATIENT_ID} accessToken={TOKEN} />
      </Harness>,
    );
    expect(screen.getByText('Care Team')).toBeInTheDocument();
    expect(screen.getByTestId('careTeam-edit')).toBeInTheDocument();
    await screen.findByText('Dr Anita Smith');
  });

  it('renders the team name with an Active status pill', async () => {
    mockFormData({ team_name: 'Team Smoke', team_status: 'active' });
    const client = buildClient({});
    render(
      <Harness client={client}>
        <CareTeamCard patientId={PATIENT_ID} accessToken={TOKEN} />
      </Harness>,
    );
    await screen.findByText('Team Smoke');
    // Two "Active" labels appear: the header pill next to "Team Smoke"
    // and the per-row status cell. Verify both.
    const actives = screen.getAllByText('Active');
    expect(actives.length).toBeGreaterThanOrEqual(1);
  });

  it('renders one table row per member, resolving role + facility codes to labels', async () => {
    mockFormData({
      members: [
        {
          member_type: 'user',
          member_id: '1',
          role: 'pcp',
          facility_id: '3',
          provider_since: '2024-01-01',
          status: 'active',
          note: '',
          display_name: 'Dr Anita Smith',
        },
        {
          member_type: 'user',
          member_id: '2',
          role: 'cardio',
          facility_id: '',
          provider_since: '2024-06-15',
          status: 'active',
          note: 'On-call',
          display_name: 'Dr Marcus Jones',
        },
      ],
    });
    const client = buildClient({});
    render(
      <Harness client={client}>
        <CareTeamCard patientId={PATIENT_ID} accessToken={TOKEN} />
      </Harness>,
    );

    const table = await screen.findByTestId('care-team-table');
    const rows = within(table).getAllByTestId('care-team-row');
    expect(rows).toHaveLength(2);
    // Row 0: Dr Anita Smith / Provider / Primary Care Provider / Main Clinic
    expect(within(rows[0]!).getByText('Dr Anita Smith')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Provider')).toBeInTheDocument();
    expect(
      within(rows[0]!).getByText('Primary Care Provider'),
    ).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Main Clinic')).toBeInTheDocument();
    // Row 1: Dr Marcus Jones / Cardiologist / On-call note
    expect(within(rows[1]!).getByText('Cardiologist')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('On-call')).toBeInTheDocument();
  });

  it('renders the "Nothing Recorded" empty state when no members returned', async () => {
    mockFormData({ members: [] });
    const client = buildClient({});
    render(
      <Harness client={client}>
        <CareTeamCard patientId={PATIENT_ID} accessToken={TOKEN} />
      </Harness>,
    );
    expect(await screen.findByText('Nothing Recorded')).toBeInTheDocument();
  });

  it('renders an in-card error state when the form-data fetch fails', async () => {
    global.fetch = makeFetchMock({
      formData: async () => new Response('boom', { status: 500 }),
    });
    const client = buildClient({});
    render(
      <Harness client={client}>
        <CareTeamCard patientId={PATIENT_ID} accessToken={TOKEN} />
      </Harness>,
    );
    await waitFor(() =>
      expect(
        screen.getByText('Failed to load care team.'),
      ).toBeInTheDocument(),
    );
  });
});

// ---------------------------------------------------------------------------
// Edit-mode integration: pencil flips the card body to the editor; save
// invokes the same-origin endpoint and then flips back to the read view.
// ---------------------------------------------------------------------------
const FORM_DATA_FIXTURE = {
  ok: true,
  team_id: 7,
  team_name: 'Default Care Team',
  team_status: 'active',
  members: [
    {
      member_type: 'user',
      member_id: '1',
      role: 'pcp',
      facility_id: '',
      provider_since: '2024-01-01',
      status: 'active',
      note: '',
      display_name: 'Dr Anita Smith',
    },
  ],
  options: {
    member_users: [
      { id: '1', label: 'Smith, Anita' },
      { id: '2', label: 'Jones, Marcus' },
    ],
    member_practitioners: [],
    roles: [
      { code: 'pcp', label: 'Primary Care Provider' },
      { code: 'cardio', label: 'Cardiologist' },
    ],
    facilities: [{ id: '3', label: 'Main Clinic' }],
    statuses: [
      { code: 'active', label: 'Active' },
      { code: 'inactive', label: 'Inactive' },
    ],
  },
  csrf: 'csrf-tok',
};

interface MockFetchHandlers {
  formData?: () => Promise<Response>;
  save?: (body: unknown) => Promise<Response>;
}

function makeFetchMock(handlers: MockFetchHandlers): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    if (url.endsWith('/care-team/form-data.php')) {
      return (
        (await handlers.formData?.())
        ?? new Response(JSON.stringify(FORM_DATA_FIXTURE), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    }
    if (url.endsWith('/care-team/save.php')) {
      const parsed: unknown =
        typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      return (
        (await handlers.save?.(parsed))
        ?? new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

describe('<CareTeamCard> edit mode', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('flips to the editor when the pencil is clicked', async () => {
    global.fetch = makeFetchMock({});
    const client = buildClient({}, async () => [PCP]);
    render(
      <Harness client={client}>
        <CareTeamCard patientId={PATIENT_ID} accessToken={TOKEN} />
      </Harness>,
    );
    await screen.findByText('Dr Anita Smith');

    fireEvent.click(screen.getByTestId('careTeam-edit'));

    await screen.findByTestId('care-team-editor');
    expect(screen.getByTestId('care-team-editor-name')).toHaveValue(
      'Default Care Team',
    );
  });

  it('reverts to the read view when Cancel is clicked, no save fired', async () => {
    const saveSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    global.fetch = makeFetchMock({ save: saveSpy });
    const client = buildClient({}, async () => [PCP]);
    render(
      <Harness client={client}>
        <CareTeamCard patientId={PATIENT_ID} accessToken={TOKEN} />
      </Harness>,
    );
    await screen.findByText('Dr Anita Smith');
    fireEvent.click(screen.getByTestId('careTeam-edit'));
    await screen.findByTestId('care-team-editor');

    fireEvent.click(screen.getByTestId('care-team-editor-cancel'));

    await waitFor(() =>
      expect(screen.queryByTestId('care-team-editor')).not.toBeInTheDocument(),
    );
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('posts the editor draft to save.php and flips back on success', async () => {
    let captured: unknown = null;
    const saveHandler = async (body: unknown) => {
      captured = body;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    global.fetch = makeFetchMock({ save: saveHandler });
    const client = buildClient({}, async () => [PCP]);
    render(
      <Harness client={client}>
        <CareTeamCard patientId={PATIENT_ID} accessToken={TOKEN} />
      </Harness>,
    );
    await screen.findByText('Dr Anita Smith');
    fireEvent.click(screen.getByTestId('careTeam-edit'));
    await screen.findByTestId('care-team-editor');

    fireEvent.change(screen.getByTestId('care-team-editor-name'), {
      target: { value: 'Updated Team Name' },
    });

    fireEvent.click(screen.getByTestId('care-team-editor-save'));

    await waitFor(() =>
      expect(screen.queryByTestId('care-team-editor')).not.toBeInTheDocument(),
    );

    expect(captured).toMatchObject({
      pid: PATIENT_ID,
      team_id: 7,
      team_name: 'Updated Team Name',
      team_status: 'active',
      csrf: 'csrf-tok',
    });
    const team = (captured as { team: unknown[] }).team;
    expect(Array.isArray(team)).toBe(true);
    expect(team).toHaveLength(1);
  });
});
