/**
 * PKCE (Proof Key for Code Exchange) utilities for SMART on FHIR public-client
 * OAuth flows.
 *
 * Pure helpers. No dependence on `window.location`. Tests can swap a fake
 * crypto by passing a custom random source — by default we use the Web Crypto
 * API, which is available in all modern browsers and in jsdom.
 */

const PKCE_CHARSET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

/** Generate a cryptographically random 64-char PKCE code_verifier. */
export function generateCodeVerifier(length = 64): string {
  if (length < 43 || length > 128) {
    throw new Error('PKCE code_verifier length must be between 43 and 128');
  }
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    const byte = bytes[i] ?? 0;
    out += PKCE_CHARSET.charAt(byte % PKCE_CHARSET.length);
  }
  return out;
}

/** Generate a random URL-safe state parameter for CSRF defense. */
export function generateState(length = 32): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    const byte = bytes[i] ?? 0;
    out += PKCE_CHARSET.charAt(byte % PKCE_CHARSET.length);
  }
  return out;
}

/**
 * Compute the SHA-256 PKCE `code_challenge` for the given verifier, encoded
 * as base64url (no padding).
 */
export async function deriveCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(digest));
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  // btoa is safe here — input is base64-charset only after this transform.
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
