/**
 * Unit tests for `<CareTeamEditor>`.
 *
 * The editor mounts itself: it owns the form-data fetch (TanStack Query)
 * and the save mutation. We mock `global.fetch` for both endpoints to keep
 * the tests self-contained.
 */

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

import { CareTeamEditor } from '../../src/components/CareTeamEditor';

const PATIENT_ID = 'patient-1';

const FORM_DATA_FIXTURE = {
  ok: true,
  team_id: 5,
  team_name: 'Care Team A',
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
      display_name: 'Smith, Anita',
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

interface FetchHandlers {
  formData?: () => Promise<Response>;
  save?: (body: unknown) => Promise<Response>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeFetchMock(handlers: FetchHandlers = {}): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    if (url.endsWith('/care-team/form-data.php')) {
      return (
        (await handlers.formData?.()) ?? jsonResponse(FORM_DATA_FIXTURE)
      );
    }
    if (url.endsWith('/care-team/save.php')) {
      const parsed: unknown =
        typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      return (await handlers.save?.(parsed)) ?? jsonResponse({ ok: true });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

function Harness({ children }: { children: ReactNode }): React.JSX.Element {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe('<CareTeamEditor>', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('hydrates rows from form-data and shows the team name', async () => {
    global.fetch = makeFetchMock();
    render(
      <Harness>
        <CareTeamEditor
          patientId={PATIENT_ID}
          onCancel={() => undefined}
          onSaved={() => undefined}
        />
      </Harness>,
    );

    await screen.findByTestId('care-team-editor');
    expect(screen.getByTestId('care-team-editor-name')).toHaveValue(
      'Care Team A',
    );
    const rows = screen.getAllByTestId('care-team-editor-row');
    expect(rows).toHaveLength(1);
  });

  it('adds and removes rows', async () => {
    global.fetch = makeFetchMock();
    render(
      <Harness>
        <CareTeamEditor
          patientId={PATIENT_ID}
          onCancel={() => undefined}
          onSaved={() => undefined}
        />
      </Harness>,
    );

    await screen.findByTestId('care-team-editor');

    fireEvent.click(screen.getByTestId('care-team-editor-add-row'));
    let rows = screen.getAllByTestId('care-team-editor-row');
    expect(rows).toHaveLength(2);

    // Remove the second row.
    const removeButtons = screen.getAllByTestId('care-team-editor-remove-row');
    expect(removeButtons).toHaveLength(2);
    fireEvent.click(removeButtons[1]!);
    rows = screen.getAllByTestId('care-team-editor-row');
    expect(rows).toHaveLength(1);
  });

  it('blocks save and surfaces validation when team name is empty', async () => {
    const saveSpy = vi.fn(async () => jsonResponse({ ok: true }));
    global.fetch = makeFetchMock({ save: saveSpy });
    render(
      <Harness>
        <CareTeamEditor
          patientId={PATIENT_ID}
          onCancel={() => undefined}
          onSaved={() => undefined}
        />
      </Harness>,
    );

    await screen.findByTestId('care-team-editor');
    fireEvent.change(screen.getByTestId('care-team-editor-name'), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByTestId('care-team-editor-save'));

    await screen.findByTestId('care-team-editor-validation');
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('blocks save when a row is missing a member', async () => {
    const saveSpy = vi.fn(async () => jsonResponse({ ok: true }));
    global.fetch = makeFetchMock({ save: saveSpy });
    render(
      <Harness>
        <CareTeamEditor
          patientId={PATIENT_ID}
          onCancel={() => undefined}
          onSaved={() => undefined}
        />
      </Harness>,
    );

    await screen.findByTestId('care-team-editor');
    fireEvent.click(screen.getByTestId('care-team-editor-add-row'));
    // The new row's member_id is empty by default — should fail validation.
    fireEvent.click(screen.getByTestId('care-team-editor-save'));

    await screen.findByTestId('care-team-editor-validation');
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('fires the save mutation and calls onSaved on success', async () => {
    let captured: unknown = null;
    const saveHandler = async (body: unknown) => {
      captured = body;
      return jsonResponse({ ok: true });
    };
    global.fetch = makeFetchMock({ save: saveHandler });
    const onSaved = vi.fn();
    render(
      <Harness>
        <CareTeamEditor
          patientId={PATIENT_ID}
          onCancel={() => undefined}
          onSaved={onSaved}
        />
      </Harness>,
    );

    await screen.findByTestId('care-team-editor');
    fireEvent.click(screen.getByTestId('care-team-editor-save'));

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(captured).toMatchObject({
      pid: PATIENT_ID,
      team_id: 5,
      team_name: 'Care Team A',
      team_status: 'active',
      csrf: 'csrf-tok',
    });
  });

  it('surfaces a save error and stays in edit mode on failure', async () => {
    const saveHandler = async () =>
      jsonResponse({ ok: false, error: 'invalid_csrf' }, 403);
    global.fetch = makeFetchMock({ save: saveHandler });
    const onSaved = vi.fn();
    render(
      <Harness>
        <CareTeamEditor
          patientId={PATIENT_ID}
          onCancel={() => undefined}
          onSaved={onSaved}
        />
      </Harness>,
    );

    await screen.findByTestId('care-team-editor');
    fireEvent.click(screen.getByTestId('care-team-editor-save'));

    const err = await screen.findByTestId('care-team-editor-save-error');
    expect(within(err).getByText(/invalid_csrf/)).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByTestId('care-team-editor')).toBeInTheDocument();
  });
});
