/**
 * SMART on FHIR EHR-launch + PKCE auth hook.
 *
 * Encapsulates:
 *
 *   1. Detecting the launch landing page (`?iss=…&launch=…`) and redirecting
 *      to the authorize endpoint with PKCE.
 *   2. Detecting the OAuth callback (`?code=…&state=…`), exchanging the code
 *      for tokens, and stashing them in React state.
 *   3. Scheduling a silent refresh (via `offline_access`) shortly before the
 *      access token's `expires_in`.
 *
 * The access token never leaves memory — never localStorage — so an XSS that
 * survives a page reload still can't lift it. The refresh token is also kept
 * in memory for v1 (the SMART launch is re-triggerable from the OpenEMR
 * patient menu, so losing the refresh token on reload is acceptable).
 *
 * Returns: `{ accessToken, patient, refreshing, error }`.
 */

import { useEffect, useRef, useState } from 'react';
import {
  generateCodeVerifier,
  generateState,
  deriveCodeChallenge,
} from './pkce';

export interface DashboardConfig {
  clientId: string;
  redirectUri: string;
  authorizeEndpoint: string;
  tokenEndpoint: string;
  scopes: string[];
  /**
   * Patient-menu items resolved server-side from
   * PatientMenuRole::getMenu(). Optional — when absent the SPA renders no
   * tab bar.
   */
  menu?: MenuItem[];
  /**
   * OpenEMR webroot prefix (e.g. `''` or `/openemr`). Joined to the
   * relative URLs inside `menu` to build absolute hrefs.
   */
  webroot?: string;
  /**
   * Patient pid (numeric, stringified) appended to menu URLs whose
   * `pid` field is the literal string `"true"`. Distinct from the
   * SMART OAuth `patient` claim — `pid` is OpenEMR's internal id and
   * the legacy menu links use it directly.
   */
  pid?: string;
}

/**
 * Patient-menu item shape, mirroring `PatientMenuRole::getMenu()` output.
 * Re-exported through the bootstrap config so `<TabBar>` can consume it.
 */
export interface MenuItem {
  label: string;
  menu_id: string;
  url?: string;
  on_click?: string;
  pid?: string;
  children?: MenuItem[];
}

export interface AuthState {
  accessToken: string | null;
  patient: string | null;
  /**
   * Stable identifier for the *logged-in OpenEMR user* (the clinician), as
   * extracted from the `id_token`'s `sub` claim. Distinct from `patient`,
   * which is the patient context for SMART/EHR launch. Used to scope
   * per-user UI state (e.g. card collapse) in localStorage so two users on
   * the same workstation don't share each other's preferences.
   *
   * `null` when no `id_token` was returned, or when the JWT could not be
   * decoded — callers that gate on userId must handle that case.
   */
  userId: string | null;
  refreshing: boolean;
  error: Error | null;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  patient?: string;
  fhirUser?: string;
  scope?: string;
  /**
   * Standard OpenID Connect ID token. Present when the SMART launch
   * requested the `openid` scope (which we always do — see test/setup.ts).
   */
  id_token?: string;
}

interface IdTokenClaims {
  sub?: unknown;
}

/**
 * Decode the `sub` claim from a JWT without verifying the signature.
 *
 * We don't verify here for two reasons:
 *
 *   1. The token came over a TLS-protected channel from the same origin's
 *      `/oauth2/default/token` endpoint moments ago — we trust it for the
 *      same reason we trust the access_token alongside it.
 *   2. We only use `sub` to scope client-side localStorage keys. A
 *      forged sub would only mis-bucket the *attacker's own* preferences;
 *      it's not used as an authorization principal.
 *
 * Returns null when the token is malformed.
 */
function extractUserIdFromIdToken(idToken: string): string | null {
  try {
    const parts = idToken.split('.');
    if (parts.length !== 3) {
      return null;
    }
    // base64url -> base64
    const payload = parts[1] ?? '';
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    // Pad to a multiple of 4.
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const json = atob(padded);
    const claims = JSON.parse(json) as IdTokenClaims;
    return typeof claims.sub === 'string' && claims.sub.length > 0
      ? claims.sub
      : null;
  } catch {
    return null;
  }
}

const VERIFIER_STORAGE_PREFIX = 'oe-dashboard-pkce-verifier:';
/** How many seconds before access-token expiry we trigger a silent refresh. */
const REFRESH_LEEWAY_SECONDS = 60;

declare global {
  interface Window {
    __OPENEMR_DASHBOARD__?: DashboardConfig;
  }
}

function readBootstrapConfig(): DashboardConfig {
  const cfg = window.__OPENEMR_DASHBOARD__;
  if (!cfg) {
    throw new Error('window.__OPENEMR_DASHBOARD__ is not set');
  }
  return cfg;
}

/**
 * Public accessor for the PHP-injected bootstrap config. `<App>` uses this
 * to read the menu/webroot/pid for the tab bar without re-implementing the
 * "is window.__OPENEMR_DASHBOARD__ defined?" guard. Returns `null` when the
 * bootstrap is missing (test harnesses, dev with no PHP) so callers can
 * fall back gracefully.
 */
export function readBootstrapConfigSafe(): DashboardConfig | null {
  return window.__OPENEMR_DASHBOARD__ ?? null;
}

/**
 * Public hook. Run once at the app root. Returns the current auth state and
 * triggers SMART launch redirects as side effects.
 */
export function useAuth(
  configOverride?: DashboardConfig,
  fetchImpl: typeof fetch = fetch,
): AuthState {
  const [state, setState] = useState<AuthState>({
    accessToken: null,
    patient: null,
    userId: null,
    refreshing: false,
    error: null,
  });

  // Keep the latest refresh token + timer in refs so we can cancel/reschedule
  // without re-running the bootstrap effect.
  const refreshTokenRef = useRef<string | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) {
      // Strict-mode double-invocation guard. Without this the callback's
      // ?code= would be exchanged twice on the first paint.
      return;
    }
    startedRef.current = true;

    const config = configOverride ?? readBootstrapConfig();
    const url = new URL(window.location.href);
    const params = url.searchParams;
    const iss = params.get('iss');
    const launch = params.get('launch');
    const code = params.get('code');
    const stateParam = params.get('state');

    if (iss && launch) {
      // Mode 1: launch landing page. Kick off the OAuth authorize redirect.
      void startAuthorize(config, iss, launch);
      return;
    }

    if (code && stateParam) {
      // Mode 2: OAuth callback. Exchange the code for tokens.
      void completeCodeExchange(config, code, stateParam);
      return;
    }

    // No SMART params on the URL. Leave state as `null` access token; the
    // shell renders a "Loading..." indicator. The PHP entry point should
    // have redirected with iss+launch on a normal Dashboard-tab click, so
    // this state is only hit during direct URL access.
    setState((s) => ({ ...s, error: new Error('No SMART launch context') }));

    return () => {
      if (refreshTimerRef.current !== null) {
        clearTimeout(refreshTimerRef.current);
      }
    };
    // We deliberately run this once. configOverride/fetchImpl are stable
    // for the lifetime of the host app (or are explicitly swapped by tests).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Build the authorize URL with PKCE params and redirect the browser. Stores
   * the verifier in sessionStorage so the callback handler can retrieve it.
   */
  async function startAuthorize(
    config: DashboardConfig,
    iss: string,
    launch: string,
  ): Promise<void> {
    try {
      const verifier = generateCodeVerifier();
      const stateValue = generateState();
      const challenge = await deriveCodeChallenge(verifier);

      window.sessionStorage.setItem(
        VERIFIER_STORAGE_PREFIX + stateValue,
        verifier,
      );

      const authorizeUrl = new URL(config.authorizeEndpoint);
      authorizeUrl.searchParams.set('response_type', 'code');
      authorizeUrl.searchParams.set('client_id', config.clientId);
      authorizeUrl.searchParams.set('redirect_uri', config.redirectUri);
      authorizeUrl.searchParams.set('scope', config.scopes.join(' '));
      authorizeUrl.searchParams.set('state', stateValue);
      authorizeUrl.searchParams.set('aud', iss);
      authorizeUrl.searchParams.set('launch', launch);
      authorizeUrl.searchParams.set('code_challenge', challenge);
      authorizeUrl.searchParams.set('code_challenge_method', 'S256');

      window.location.replace(authorizeUrl.toString());
    } catch (err) {
      setState((s) => ({ ...s, error: toError(err) }));
    }
  }

  /**
   * POST the authorization code to the token endpoint, validate the response,
   * and seed React state with the access token + patient context.
   */
  async function completeCodeExchange(
    config: DashboardConfig,
    code: string,
    stateValue: string,
  ): Promise<void> {
    try {
      const verifier = window.sessionStorage.getItem(
        VERIFIER_STORAGE_PREFIX + stateValue,
      );
      if (verifier === null) {
        throw new Error('Missing PKCE verifier for state');
      }
      window.sessionStorage.removeItem(VERIFIER_STORAGE_PREFIX + stateValue);

      const body = new URLSearchParams();
      body.set('grant_type', 'authorization_code');
      body.set('code', code);
      body.set('redirect_uri', config.redirectUri);
      body.set('client_id', config.clientId);
      body.set('code_verifier', verifier);

      const res = await fetchImpl(config.tokenEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: body.toString(),
      });
      if (!res.ok) {
        throw new Error(`Token exchange failed: HTTP ${res.status}`);
      }
      const tokens = (await res.json()) as TokenResponse;

      // Strip the OAuth params from the URL so a refresh doesn't re-run code
      // exchange. We only keep the dashboard URL itself.
      const cleanUrl = window.location.pathname;
      window.history.replaceState({}, document.title, cleanUrl);

      applyTokenResponse(tokens, config);
    } catch (err) {
      setState((s) => ({ ...s, error: toError(err) }));
    }
  }

  /**
   * Refresh the access token using the stored refresh_token. Triggered by a
   * scheduled timer; can also be called manually if needed in future.
   */
  async function refreshAccessToken(config: DashboardConfig): Promise<void> {
    const refreshToken = refreshTokenRef.current;
    if (refreshToken === null) {
      return;
    }
    setState((s) => ({ ...s, refreshing: true }));
    try {
      const body = new URLSearchParams();
      body.set('grant_type', 'refresh_token');
      body.set('refresh_token', refreshToken);
      body.set('client_id', config.clientId);

      const res = await fetchImpl(config.tokenEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: body.toString(),
      });
      if (!res.ok) {
        throw new Error(`Token refresh failed: HTTP ${res.status}`);
      }
      const tokens = (await res.json()) as TokenResponse;
      applyTokenResponse(tokens, config);
    } catch (err) {
      setState((s) => ({ ...s, refreshing: false, error: toError(err) }));
    }
  }

  function applyTokenResponse(
    tokens: TokenResponse,
    config: DashboardConfig,
  ): void {
    if (typeof tokens.access_token !== 'string') {
      throw new Error('Token response missing access_token');
    }
    if (typeof tokens.refresh_token === 'string') {
      refreshTokenRef.current = tokens.refresh_token;
    }

    const userId
      = typeof tokens.id_token === 'string'
        ? extractUserIdFromIdToken(tokens.id_token)
        : null;

    setState((prev) => ({
      accessToken: tokens.access_token,
      patient: typeof tokens.patient === 'string' ? tokens.patient : null,
      // A refresh response may omit id_token; preserve the previously
      // resolved userId rather than clobbering it to null.
      userId: userId ?? prev.userId,
      refreshing: false,
      error: null,
    }));

    if (refreshTimerRef.current !== null) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
    if (
      typeof tokens.expires_in === 'number'
      && refreshTokenRef.current !== null
    ) {
      const delayMs = Math.max(
        (tokens.expires_in - REFRESH_LEEWAY_SECONDS) * 1000,
        0,
      );
      refreshTimerRef.current = setTimeout(() => {
        void refreshAccessToken(config);
      }, delayMs);
    }
  }

  return state;
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
