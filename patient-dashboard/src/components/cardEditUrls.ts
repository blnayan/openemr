/**
 * Legacy edit deep-links for each clinical card's pencil affordance.
 *
 * The dashboard SPA is mounted under `/interface/patient_file/summary/...`
 * and shares a session cookie with the rest of OpenEMR, so opening these
 * URLs in a new tab carries the patient context and authentication
 * through automatically — no further auth handoff is required.
 *
 * Why a single module? Each card knows its own URL, and we could inline
 * them. Centralizing keeps the URLs greppable, makes future migrations
 * (e.g. when one of these legacy pages moves to a new path) a single-file
 * change, and gives smoke tests one place to verify against.
 *
 * URL provenance: derived by inspecting `interface/patient_file/summary/
 * demographics.php`'s "Edit" anchor for each clinical section. The query
 * string `active=all&category=<name>` is the long-standing convention for
 * the `stats_full.php` editor.
 *
 * Care Team is intentionally NOT in this map — issue #42 replaced the
 * link-out with a native React editor (`<CareTeamEditor>`) that flips the
 * card body in place. Don't reintroduce the entry here without first
 * removing the in-card editor.
 *
 * Lab Results: `labdata.php` is the historical labs entry. If a future
 * release changes that path, update here and the smoke test in lockstep.
 */

export const CARD_EDIT_URLS = {
  allergies:
    '/interface/patient_file/summary/stats_full.php?active=all&category=allergy',
  problems:
    '/interface/patient_file/summary/stats_full.php?active=all&category=medical_problem',
  medications:
    '/interface/patient_file/summary/stats_full.php?active=all&category=medication',
  prescriptions:
    '/interface/patient_file/summary/stats_full.php?active=all&category=prescription',
  labResults: '/interface/patient_file/summary/labdata.php',
} as const;

export type CardEditId = keyof typeof CARD_EDIT_URLS;

/**
 * Open the legacy editor for the given card in a new tab.
 *
 * Wrapped here (rather than inlining `window.open` at every call site) so
 * the noopener/noreferrer hint is applied uniformly — opening a same-
 * origin tab and then leaving the SPA tab untracked by `window.opener`
 * is the right default.
 */
export function openCardEditor(cardId: CardEditId): void {
  window.open(CARD_EDIT_URLS[cardId], '_blank', 'noopener,noreferrer');
}
