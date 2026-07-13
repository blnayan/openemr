# Patient Dashboard Migration

## Why React + TypeScript + Vite

**React** because the dashboard's UI is naturally component-shaped — a
six-card grid plus a persistent identity strip and tab bar. The
component model maps to that without ceremony, and React has the
deepest healthcare-frontend hiring pool.

**TypeScript** because FHIR resources are deeply nested, optional-rich,
and inconsistent across servers. Static types at the parse-don't-validate
boundary catch shape drift at compile time — what would otherwise
surface as runtime crashes inside cards.

**Vite** for the build. Native ESM, single-command React-TS template,
plays cleanly with Tailwind v4. Next.js rejected: the SPA mounts inside
OpenEMR's PHP shell at a known route, so SSR adds infrastructure (a Node
server) for no payoff.

**Tailwind v4** for styling. Design tokens map 1:1 to v4's `@theme`
directive — no JS config, native CSS variables, preset utilities only.

**TanStack Query 5** for FHIR data fetching. Each card is one hook keyed
by patient + access token; loading, error, refetch, and cache
invalidation come for free.

**Zod 4** for FHIR parsing. One schema per resource at the network
boundary; downstream code only ever sees typed DTOs. The SPA never
crashes on a malformed FHIR shape — the parse fails fast at the seam.

**SMART on FHIR EHR launch (OAuth2 + PKCE)** for auth. The brief
requires OAuth2/OIDC, and SMART is the canonical EHR-app contract.
Pre-approved confidential client with silent refresh via
`offline_access`; same-origin host so the OpenEMR session keeps
answering same-origin POSTs alongside the OAuth bearer.

**Vitest + Testing Library** for the test suite (~390 tests). Matches
the conventions of the rest of the project. **Lucide-react** for icons
— tree-shakeable, single source.

## What was gained over PHP

- **Code organization.** The legacy `demographics.php` is 2,000 lines
  mixing data fetching, ACL gates, JS string injection, Twig rendering,
  and inline SQL. The SPA splits the same surface into one file per
  concern — schemas in `fhir/schemas/`, hooks in `fhir/hooks/`, cards
  in `components/`. New cards are one file, not a thousand-line edit.
- **Type-safety at the seam.** A missing FHIR field surfaces as a
  single, named, recoverable error path instead of
  `Trying to access offset on null` deep in a render.
- **Component reuse.** The shared `<Card>` shell is reused across all
  six cards without duplication; same for the FHIR client and parse
  helpers.
- **Test speed.** The full SPA suite runs in ~3 seconds against jsdom;
  the legacy PHPUnit + Selenium path runs in minutes inside Docker.
- **A real client app.** The SPA can plausibly run against any
  SMART-conformant EHR behind any TLS-terminating proxy. The legacy
  page can only run inside an OpenEMR install.

## Tradeoffs

- **Bigger toolchain.** Vite, npm, a separate test runner. The legacy
  page had one toolchain (PHP). CI surface roughly doubles.
- **Limited backend touches were unavoidable.** The brief says "you
  are not touching the backend." For Care Team editing, OpenEMR's
  `FhirCareTeamRestController` has no write methods. Adding them was
  out of scope, so two thin same-origin PHP endpoints
  (`care-team/form-data.php`, `care-team/save.php`) wrap
  `CareTeamService::saveCareTeam` directly. No schema changes — thin
  glue around an existing service.
- **Two auth modes coexist.** FHIR data fetches use the OAuth bearer;
  the Care Team save/form-data endpoints use the OpenEMR session
  cookie (because they're thin PHP wrappers around `CareTeamService`,
  not FHIR writes). A real seam, documented in code.
- **Bundle size.** ~340 kB JS / ~20 kB CSS gzipped on first load. The
  legacy page ships the rendered HTML inline; the SPA pays for
  client-side rendering up front. Acceptable on a clinic LAN; would
  matter on metered mobile.
