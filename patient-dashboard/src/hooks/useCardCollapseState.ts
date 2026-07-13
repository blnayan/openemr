/**
 * Per-user, per-patient persistence for card open/closed state.
 *
 * The W2 PRD asks for collapsible dashboard cards whose state survives a
 * page reload but is *scoped* — a clinician's preference for "Care Team
 * collapsed on Margaret's chart" should not bleed into Bob's chart, and
 * two clinicians sharing a workstation should not see each other's
 * collapsed cards.
 *
 * Storage layout
 * --------------
 *
 * Keys are flat strings in `window.localStorage`:
 *
 *     dashboard:cardCollapse:<userId>:<pid>:<cardId>
 *
 * - `<userId>` — OpenEMR user id_token `sub` claim (the clinician). When
 *   no id_token is available we fall back to the literal string `anon`,
 *   so preferences still persist on a single workstation but won't be
 *   wrongly attributed across users.
 * - `<pid>`    — current patient context (the SMART `patient` claim).
 * - `<cardId>` — the stable card id passed in by the caller (e.g.
 *   `allergies`, `problems`, `medications`).
 *
 * Values are the literal strings `"open"` or `"closed"`. We deliberately
 * do not use JSON; the value is a closed enum and string round-tripping
 * is simpler to reason about (and to wipe with a `localStorage.clear()`
 * or a key-prefix scan).
 *
 * Default: when no entry exists, the card is considered **open**. This
 * matches the PRD: clinical cards default open so safety-critical
 * information is never hidden behind an extra click on first paint.
 *
 * Why explicit `userId` / `pid` parameters?
 * -----------------------------------------
 *
 * The hook deliberately does NOT call `useAuth()` itself. The auth state
 * is already resolved at the SPA shell (`App.tsx`) and threaded down to
 * the cards as props alongside `accessToken` / `patientId`. Re-calling
 * `useAuth()` here would (a) couple every card render to the auth state
 * machine and (b) make the hook hard to unit-test in isolation. Cards
 * pass their `pid` (already in scope as `patientId`) and the `userId`
 * surfaced by the shell.
 *
 * Wipe / migration
 * ----------------
 *
 * To clear a user's collapse preferences across all patients/cards:
 *
 *     for (const k of Object.keys(localStorage)) {
 *       if (k.startsWith(`dashboard:cardCollapse:${userId}:`)) {
 *         localStorage.removeItem(k);
 *       }
 *     }
 *
 * To migrate the key format, prefer adding a *new* prefix (e.g.
 * `dashboard:cardCollapse:v2:…`) and leaving the old keys in place — they
 * fall back to "open" defaults harmlessly.
 */

import { useCallback, useEffect, useState } from 'react';

const STORAGE_PREFIX = 'dashboard:cardCollapse';
const VALUE_OPEN = 'open';
const VALUE_CLOSED = 'closed';

/**
 * Build the storage key. Exported for tests so they can pre-seed
 * localStorage without re-deriving the format string.
 */
export function buildCardCollapseKey(
  userId: string | null,
  pid: string | null,
  cardId: string,
): string {
  const u = userId !== null && userId !== '' ? userId : 'anon';
  const p = pid !== null && pid !== '' ? pid : 'anon';
  return `${STORAGE_PREFIX}:${u}:${p}:${cardId}`;
}

/**
 * Returns `[isOpen, toggle]` for the given card, persisting changes to
 * localStorage scoped by userId+pid+cardId.
 *
 * Pass `null` for `userId` and/or `pid` when those values aren't yet
 * resolved — the hook will use the literal `"anon"` segment so preferences
 * still persist (and re-keying happens automatically once the real values
 * arrive on a subsequent render, via the re-hydration effect below).
 */
export function useCardCollapseState(
  cardId: string,
  userId: string | null = null,
  pid: string | null = null,
): [boolean, () => void] {
  const key = buildCardCollapseKey(userId, pid, cardId);

  // Lazy initializer: read localStorage once on mount. Default to open.
  const [isOpen, setIsOpen] = useState<boolean>(() => readIsOpen(key));

  // If the key changes (e.g. patient switch within a single SPA mount, or
  // userId resolving from null → real id_token sub), re-hydrate from the
  // new key. We don't keep a write effect here — toggle() writes
  // synchronously alongside setIsOpen.
  useEffect(() => {
    setIsOpen(readIsOpen(key));
  }, [key]);

  const toggle = useCallback(() => {
    setIsOpen((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(key, next ? VALUE_OPEN : VALUE_CLOSED);
      } catch {
        // localStorage can throw in private browsing / quota-exceeded
        // scenarios. Swallow — the in-memory state still updates so the
        // current session still toggles correctly. Persistence is a nice
        // to have, not a correctness requirement.
      }
      return next;
    });
  }, [key]);

  return [isOpen, toggle];
}

function readIsOpen(key: string): boolean {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === VALUE_CLOSED) {
      return false;
    }
    if (raw === VALUE_OPEN) {
      return true;
    }
    // Missing or unrecognized value → default open.
    return true;
  } catch {
    return true;
  }
}
