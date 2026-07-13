/**
 * Patient nav tab bar (Dashboard / History / Assessments / Report /
 * Documents / Document Inbox / Transactions).
 *
 * Renders the OpenEMR patient menu styled to the dashboard's design tokens
 * — 2px `--blue` underline + 500 weight on the active tab, `--ink-2`
 * elsewhere, dropdown caret on items with children. Replaces the Bootstrap
 * navbar that legacy `demographics.php` produced via
 * `PatientMenuRole::displayHorizNavBarMenu()`.
 *
 * Data shape mirrors `PatientMenuRole::getMenu()`. The PHP shell injects
 * `window.__OPENEMR_DASHBOARD__.menu` — see `interface/patient_file/summary/
 * dashboard/index.php`. When the bootstrap blob is missing or an item is
 * malformed the bar falls back to empty/skipping, never throws.
 *
 * Pencil/dropdown click follows the same `top.restoreSession()` convention
 * the legacy menu uses so OpenEMR's main iframe shell registers the nav.
 */

import React from 'react';

export interface MenuItem {
  /** Display label. Already i18n-resolved upstream. */
  label: string;
  /** Stable id used to mark the active tab. */
  menu_id: string;
  /** Relative URL (without webroot prefix) or absolute http(s) URL. */
  url?: string;
  /** Optional inline onclick handler (e.g. `top.restoreSession()`). */
  on_click?: string;
  /** When the literal string `"true"`, append the patient pid to `url`. */
  pid?: string;
  /** Sub-items rendered as a dropdown. */
  children?: ReadonlyArray<MenuItem>;
}

export interface TabBarProps {
  items: ReadonlyArray<MenuItem>;
  activeId: string;
  webroot: string;
  /** Patient pid to append when `item.pid === 'true'`. */
  pid: string;
}

export function TabBar({
  items,
  activeId,
  webroot,
  pid,
}: TabBarProps): React.JSX.Element {
  return (
    <nav
      className="bg-bg-card border-b border-border px-6 font-sans text-base text-ink-2"
      aria-label="Patient navigation"
    >
      <ul className="flex gap-6 m-0 p-0 list-none">
        {items.map((item) => (
          <TabBarItem
            key={item.menu_id}
            item={item}
            isActive={item.menu_id === activeId}
            webroot={webroot}
            pid={pid}
          />
        ))}
      </ul>
    </nav>
  );
}

// Color + border-color are split out of the base set so the active and
// inactive variants don't both ship the same Tailwind property: when two
// utilities for one property land on one element, the CSS source order
// (which Tailwind controls, not us) decides — and that's independent of
// the class-string order, so concatenating "text-ink-2 ... text-blue"
// silently lets text-ink-2 win.
const LINK_BASE =
  'inline-block py-3 no-underline cursor-pointer border-b-2 transition-colors duration-100 select-none bg-transparent';
const LINK_INACTIVE = 'text-ink-2 border-transparent hover:text-blue';
const LINK_ACTIVE = 'text-blue font-medium border-blue';

interface TabBarItemProps {
  item: MenuItem;
  isActive: boolean;
  webroot: string;
  pid: string;
}

function TabBarItem({
  item,
  isActive,
  webroot,
  pid,
}: TabBarItemProps): React.JSX.Element {
  // Items with children (e.g. Assessments) used to render as a dropdown.
  // Per request the dropdown is gone entirely — render the parent as a
  // plain link to its first child's URL when the parent itself has none,
  // so the tab still leads somewhere useful.
  const firstChild = item.children?.[0];
  let linkItem: MenuItem = item;
  if (item.url == null && firstChild != null) {
    // exactOptionalPropertyTypes — only set fields that aren't undefined.
    linkItem = { ...item };
    if (firstChild.url !== undefined) linkItem.url = firstChild.url;
    if (firstChild.on_click !== undefined) linkItem.on_click = firstChild.on_click;
    if (firstChild.pid !== undefined) linkItem.pid = firstChild.pid;
  }

  const linkClass = isActive
    ? `${LINK_BASE} ${LINK_ACTIVE}`
    : `${LINK_BASE} ${LINK_INACTIVE}`;

  return (
    <li className="relative">
      <a
        className={linkClass}
        id={item.menu_id}
        href={resolveHref(linkItem, webroot, pid)}
        onClick={makeClickHandler(linkItem.on_click)}
        {...(isActive ? { 'aria-current': 'page' as const } : {})}
      >
        {item.label}
      </a>
    </li>
  );
}

/**
 * Build the resolved click target. `item.pid === "true"` means append the
 * patient id (the legacy menu encodes pid this way as a stringly flag).
 * Absolute URLs pass through unchanged so the menu can host external links.
 */
export function resolveHref(item: MenuItem, webroot: string, pid: string): string {
  const url = item.url ?? '';
  const absolute = /^https?:\/\//i.test(url) ? url : trimSlash(webroot) + '/' + trimLeadSlash(url);
  return item.pid === 'true' ? absolute + pid : absolute;
}

function trimSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function trimLeadSlash(s: string): string {
  return s.startsWith('/') ? s.slice(1) : s;
}

/**
 * The legacy menu uses raw strings like `top.restoreSession()` for
 * `on_click`. Wrap in a tiny eval-ish handler so React's onClick can fire
 * it without the SPA having to know about each handler. eval-style is
 * confined to strings the OpenEMR backend ships — never user input.
 */
function makeClickHandler(onClick: string | undefined):
  | ((event: React.MouseEvent<HTMLAnchorElement>) => void)
  | undefined {
  const trimmed = onClick?.trim() ?? '';
  if (trimmed === '') {
    return undefined;
  }
  return () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
      new Function(trimmed)();
    } catch (e) {
      // Don't break navigation if the embedded handler throws; the
      // browser will still follow the link's href.
      console.error('tab-bar onclick handler failed:', e);
    }
  };
}
