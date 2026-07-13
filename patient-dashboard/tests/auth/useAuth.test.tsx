import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useAuth, type DashboardConfig } from '../../src/auth/useAuth';

const TEST_CONFIG: DashboardConfig = {
  clientId: 'patient-dashboard-spa',
  redirectUri: 'http://localhost/cb',
  authorizeEndpoint: 'http://localhost/oauth2/default/authorize',
  tokenEndpoint: 'http://localhost/oauth2/default/token',
  scopes: ['openid', 'launch/patient', 'patient/Patient.rs', 'offline_access'],
};

function setLocation(href: string): void {
  // jsdom lets us replace window.location via assignment to .href when the
  // host matches; for a clean replacement use Object.defineProperty.
  const url = new URL(href);
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: {
      href: url.href,
      origin: url.origin,
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
      replace: vi.fn(),
      assign: vi.fn(),
    },
  });
}

beforeEach(() => {
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useAuth — happy path (authorization code exchange)', () => {
  it('exchanges the callback code for tokens and exposes the patient claim', async () => {
    // Pre-seed the PKCE verifier as if startAuthorize had stored it before
    // the redirect to /authorize. The callback URL carries `state=xyz`.
    window.sessionStorage.setItem(
      'oe-dashboard-pkce-verifier:test-state',
      'verifier-abc',
    );
    setLocation(
      'http://localhost/interface/patient_file/summary/dashboard/index.php?code=auth-code-1&state=test-state',
    );

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'access-1',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'refresh-1',
        patient: 'patient-uuid-42',
      }),
    });

    const { result } = renderHook(() =>
      useAuth(TEST_CONFIG, fetchMock as unknown as typeof fetch),
    );

    await waitFor(() => {
      expect(result.current.accessToken).toBe('access-1');
    });
    expect(result.current.patient).toBe('patient-uuid-42');
    expect(result.current.error).toBeNull();

    // Token endpoint was hit with the correct PKCE verifier.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const tokenCall = fetchMock.mock.calls[0]!;
    expect(tokenCall[0]).toBe(TEST_CONFIG.tokenEndpoint);
    const reqBody = (tokenCall[1] as { body: string }).body;
    expect(reqBody).toContain('grant_type=authorization_code');
    expect(reqBody).toContain('code=auth-code-1');
    expect(reqBody).toContain('code_verifier=verifier-abc');

    // Verifier was deleted from sessionStorage post-exchange.
    expect(
      window.sessionStorage.getItem('oe-dashboard-pkce-verifier:test-state'),
    ).toBeNull();
  });
});

describe('useAuth — refresh path', () => {
  it('silently refreshes the access token before expiry', async () => {
    window.sessionStorage.setItem(
      'oe-dashboard-pkce-verifier:s1',
      'verifier-1',
    );
    setLocation(
      'http://localhost/interface/patient_file/summary/dashboard/index.php?code=c1&state=s1',
    );

    const fetchMock = vi
      .fn()
      // First call: code exchange.
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'access-initial',
          token_type: 'Bearer',
          // Short-lived so the refresh fires quickly.
          expires_in: 65,
          refresh_token: 'refresh-1',
          patient: 'p-1',
        }),
      })
      // Second call: refresh.
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'access-refreshed',
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: 'refresh-2',
          patient: 'p-1',
        }),
      });

    // Switch to fake timers AFTER the hook has run its initial code-exchange
    // micro-tasks so the `waitFor` in this test still uses the real clock.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const { result } = renderHook(() =>
      useAuth(TEST_CONFIG, fetchMock as unknown as typeof fetch),
    );

    await vi.waitFor(() => {
      expect(result.current.accessToken).toBe('access-initial');
    });

    // Advance past the (expires_in - 60s) leeway window.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    await vi.waitFor(() => {
      expect(result.current.accessToken).toBe('access-refreshed');
    });
    expect(result.current.refreshing).toBe(false);

    // Refresh request used grant_type=refresh_token + the original refresh
    // token.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const refreshBody = (fetchMock.mock.calls[1]![1] as { body: string }).body;
    expect(refreshBody).toContain('grant_type=refresh_token');
    expect(refreshBody).toContain('refresh_token=refresh-1');
  });
});

describe('useAuth — userId from id_token', () => {
  // Helper: build an unsigned-ish JWT with the given payload claims. We only
  // need the payload-segment base64url-decoding logic to round-trip; the
  // header + signature are placeholder strings since useAuth doesn't verify.
  function makeIdToken(payload: object): string {
    const b64 = (s: string): string =>
      // jsdom exposes btoa; that's enough for a same-origin ASCII payload.
      btoa(s).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    const header = b64('{"alg":"none","typ":"JWT"}');
    const body = b64(JSON.stringify(payload));
    return `${header}.${body}.sig`;
  }

  it('extracts the sub claim from the id_token and exposes it as userId', async () => {
    window.sessionStorage.setItem(
      'oe-dashboard-pkce-verifier:s-uid',
      'verifier-uid',
    );
    setLocation(
      'http://localhost/interface/patient_file/summary/dashboard/index.php?code=c-uid&state=s-uid',
    );

    const idToken = makeIdToken({ sub: 'clinician-uuid-9' });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'a-1',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'r-1',
        patient: 'p-1',
        id_token: idToken,
      }),
    });

    const { result } = renderHook(() =>
      useAuth(TEST_CONFIG, fetchMock as unknown as typeof fetch),
    );

    await waitFor(() => {
      expect(result.current.userId).toBe('clinician-uuid-9');
    });
    expect(result.current.accessToken).toBe('a-1');
  });

  it('leaves userId null when no id_token is returned', async () => {
    window.sessionStorage.setItem(
      'oe-dashboard-pkce-verifier:s-no-idt',
      'verifier-no-idt',
    );
    setLocation(
      'http://localhost/interface/patient_file/summary/dashboard/index.php?code=c-no-idt&state=s-no-idt',
    );

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'a-2',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'r-2',
        patient: 'p-2',
        // No id_token in the response.
      }),
    });

    const { result } = renderHook(() =>
      useAuth(TEST_CONFIG, fetchMock as unknown as typeof fetch),
    );

    await waitFor(() => {
      expect(result.current.accessToken).toBe('a-2');
    });
    expect(result.current.userId).toBeNull();
  });

  it('leaves userId null when the id_token is malformed', async () => {
    window.sessionStorage.setItem(
      'oe-dashboard-pkce-verifier:s-bad',
      'verifier-bad',
    );
    setLocation(
      'http://localhost/interface/patient_file/summary/dashboard/index.php?code=c-bad&state=s-bad',
    );

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'a-3',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'r-3',
        patient: 'p-3',
        id_token: 'this-is-not-a-jwt',
      }),
    });

    const { result } = renderHook(() =>
      useAuth(TEST_CONFIG, fetchMock as unknown as typeof fetch),
    );

    await waitFor(() => {
      expect(result.current.accessToken).toBe('a-3');
    });
    expect(result.current.userId).toBeNull();
  });
});

describe('useAuth — error path', () => {
  it('surfaces a network error when the token endpoint fails', async () => {
    window.sessionStorage.setItem(
      'oe-dashboard-pkce-verifier:err-state',
      'verifier-x',
    );
    setLocation(
      'http://localhost/interface/patient_file/summary/dashboard/index.php?code=bad&state=err-state',
    );

    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({}),
    });

    const { result } = renderHook(() =>
      useAuth(TEST_CONFIG, fetchMock as unknown as typeof fetch),
    );

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });
    expect(result.current.accessToken).toBeNull();
    expect(result.current.error?.message).toMatch(/Token exchange failed/);
  });
});
