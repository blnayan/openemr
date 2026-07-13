/**
 * Unit tests for `fetchCareTeamFormData` (the pure fetch wrapper used by
 * `useCareTeamForm`). The hook itself is exercised end-to-end via the
 * `<CareTeamEditor>` and `<CareTeamCard>` integration tests; this file
 * pins the fetch's contract directly so the wire shape is self-documenting.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchCareTeamFormData } from '../../../src/fhir/hooks/useCareTeamForm';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('fetchCareTeamFormData', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns the parsed payload on a successful 200', async () => {
    const fixture = {
      ok: true,
      team_id: 7,
      team_name: 'Default',
      team_status: 'active',
      members: [],
      options: {
        member_users: [],
        member_practitioners: [],
        roles: [],
        facilities: [],
        statuses: [],
      },
      csrf: 'tok-1',
    };
    global.fetch = vi.fn(async () =>
      jsonResponse(fixture),
    ) as unknown as typeof fetch;

    const result = await fetchCareTeamFormData();
    expect(result.team_id).toBe(7);
    expect(result.team_name).toBe('Default');
    expect(result.csrf).toBe('tok-1');
  });

  it('throws when the HTTP response is non-2xx', async () => {
    global.fetch = vi.fn(async () =>
      jsonResponse({ ok: false, error: 'forbidden' }, 403),
    ) as unknown as typeof fetch;

    await expect(fetchCareTeamFormData()).rejects.toThrow(/403/);
  });

  it('throws when the body reports ok=false', async () => {
    global.fetch = vi.fn(async () =>
      jsonResponse({ ok: false, error: 'pid_mismatch' }),
    ) as unknown as typeof fetch;

    await expect(fetchCareTeamFormData()).rejects.toThrow(/pid_mismatch/);
  });
});
