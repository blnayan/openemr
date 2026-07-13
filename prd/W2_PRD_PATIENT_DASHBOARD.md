# Patient Dashboard — Conservative Refresh + Clinical Co-Pilot Integration

## Problem Statement

A primary care physician opening a patient chart in OpenEMR today lands on
`demographics.php` — a 2,000-line legacy PHP page that renders a Bootstrap
4.6 grid of cards. The page works, but it has three problems the physician
feels every encounter:

1. **Safety-critical signals don't stand out.** Severe allergies render in
   the same row chrome as mild ones. Out-of-range lab values look the same
   as in-range. The clinician has to read every row carefully because
   nothing is visually privileged.
2. **The identity strip is inconsistent.** The patient name, DOB, MRN, and
   active status are spread across the page header rather than pinned in a
   single, always-visible strip — so during a long scroll the clinician can
   lose track of which patient's chart they're in.
3. **The Clinical Co-Pilot is bolted on.** The existing `<agent-sidebar>`
   Web Component works but lives in a 380px floating panel that doesn't
   match the rest of the design system, uses system fonts and generic
   shadows, and is structurally separate from the dashboard's visual
   language.

A pixel-perfect design refresh exists (see
`design_handoff_patient_dashboard/`) that addresses all three issues —
severity-tinted allergy rows, a persistent identity strip, a redesigned
Co-Pilot dock with citation chips — but it lives in React/JSX prototypes,
not in the OpenEMR codebase. The codebase has no React, no JSX build
pipeline, and the legacy page predates the design system.

## Solution

Replace the patient dashboard's entry point with a **React + TypeScript
SPA** launched via **SMART on FHIR EHR launch**, served same-origin from
OpenEMR. The SPA renders the six clinical cards required by the brief
(Allergies, Problem List, Medications, Prescriptions, Care Team, Lab
Results), the persistent identity strip, and a redesigned Clinical Co-Pilot
dock that consumes the existing AgentForge backend via the existing
`chat.php` SSE endpoint.

The legacy `demographics.php` stays on disk as an unlinked fallback. The
existing `<agent-sidebar>` Web Component is replaced by a native React dock
component that hits the same backend contract.

Concretely, the physician's experience changes as follows:

- Clicking the patient's "Dashboard" tab triggers a SMART launch flow (no
  consent prompt thanks to a pre-approved client) and lands them in the
  redesigned dashboard with the patient already bound — no patient picker,
  no extra clicks.
- A persistent identity strip pinned below the top bar shows name, DOB,
  age, sex, MRN, and an active-status pill — readable at any scroll
  position.
- The Allergies card visually privileges severity: moderate allergies get a
  red-tinted row background, mild allergies amber, unknown grey. Severity
  tinting is **only** used here — by design, to preserve its safety signal.
- The Lab Results card flags out-of-range values in red using FHIR
  `Observation.interpretation` codes (`H`, `HH`, `L`, `LL`, `A`).
- The floating Co-Pilot dock (bottom-right) opens with the patient already
  in context, streams citation-grounded answers from the existing AgentForge
  backend, and offers up to three "Suggested next" follow-up chips that
  fill-and-submit on click.
- All cards are collapsible; collapse state is persisted per user + per
  patient + per card in `localStorage`. Clinical cards default open.
- Edit affordances (pencil icons) link out to the existing legacy PHP edit
  flows in a new window — edit pages are explicitly out of scope for this
  refresh.

## User Stories

1. As a primary-care physician, I want to click a patient's "Dashboard" tab
   and land on the redesigned dashboard with the patient already in
   context, so that I don't have to re-pick the patient or click through a
   consent screen.
2. As a primary-care physician, I want the patient's name, DOB, age, sex,
   MRN, and active status pinned in a strip immediately below the top bar,
   so that I never lose track of which chart I'm in during a long scroll.
3. As a primary-care physician, I want the patient's MRN and DOB rendered
   in a monospaced font (IBM Plex Mono), so that digits align and I can
   read identifiers quickly without misreading characters.
4. As a primary-care physician, I want the Allergies card to visually
   privilege severity by tinting moderate allergies red, mild allergies
   amber, and unknown grey, so that severe drug allergies catch my eye
   before I sign an order.
5. As a primary-care physician, I want severity-tinted full-row backgrounds
   to be used **only** in the Allergies card, so that the safety signal
   stays meaningful and isn't diluted across other sections.
6. As a primary-care physician, I want the Problem List card to show my
   patient's active conditions in a plain-row list, so that I can scan the
   problem list at a glance.
7. As a primary-care physician, I want the Medications card to show the
   patient's active medication list, so that I have ambient awareness of
   what they're on before prescribing.
8. As a primary-care physician, I want the Prescriptions card to show
   active prescription orders, so that I can confirm what's been written
   recently.
9. As a primary-care physician, I want the Care Team card to show the
   providers and roles caring for this patient, so that I know who else is
   involved before suggesting referrals.
10. As a primary-care physician, I want the Lab Results card to flag
    out-of-range values in red using the lab system's own
    `Observation.interpretation` codes, so that abnormal results are
    visually obvious without me hunting for the reference range.
11. As a primary-care physician, I want each card to be collapsible by
    clicking its title, so that I can hide cards I don't need right now
    and reduce visual noise.
12. As a primary-care physician, I want my collapse choices remembered
    per-patient on this device, so that the dashboard re-opens the way I
    left it next time I come back to this chart.
13. As a primary-care physician, I want clinical cards (Allergies,
    Problems, Medications, Prescriptions, Care Team, Labs) to default open
    when I land on a new patient, so that the most important information
    is immediately visible.
14. As a primary-care physician, I want the pencil/edit affordance on a
    card to take me to the existing OpenEMR edit page, so that I can
    update data using the flows I already know.
15. As a primary-care physician, I want clicking the pencil to open the
    edit page in a new tab/window, so that my dashboard state is preserved
    when I come back.
16. As a primary-care physician, I want a floating Clinical Co-Pilot
    launcher button bottom-right of the dashboard, so that I can ask
    questions about the chart without leaving the page.
17. As a primary-care physician, I want the launcher to show an "online"
    indicator, so that I know whether the agent is reachable before I
    click.
18. As a primary-care physician, I want the Co-Pilot dock to open with the
    current patient already pre-bound (shown as a pill in the context
    bar), so that I don't have to repeat which patient I'm asking about.
19. As a primary-care physician, I want the dock to remain bound to the
    correct patient if I navigate to a different chart while it's open, so
    that I never see stale answers from a previous patient.
20. As a primary-care physician, I want every Co-Pilot answer to include
    citation chips that point to specific chart objects (lab rows,
    medication rows, problems) or documents, so that I can verify any
    claim against its source before acting on it.
21. As a primary-care physician, I want chart-data citations rendered as
    blue chips and document citations rendered as amber chips, so that I
    can visually distinguish at a glance whether a claim came from
    structured data or a parsed document.
22. As a primary-care physician, I want concrete clinical values in the
    answer (A1c numbers, LDL, doses) bolded inline, so that the values I
    scan for are visually privileged in the prose.
23. As a primary-care physician, I want answers to stream token-by-token,
    so that I can start reading immediately rather than wait for the full
    response.
24. As a primary-care physician, I want up to three "Suggested next"
    follow-up chips after each answer, so that I have one-click follow-ups
    relevant to the current chart and conversation.
25. As a primary-care physician, I want clicking a "Suggested next" chip
    to fill the input AND submit it, so that following up is one tap, not
    type-and-send.
26. As a primary-care physician, I want the dock to be collapsible,
    expandable to a larger size, and closable, so that I can size it to
    fit the work I'm doing.
27. As a primary-care physician, I want pressing Escape to close the
    dock, so that I have a fast keyboard exit when I'm done.
28. As a primary-care physician, I want the Co-Pilot to never take write
    actions (place orders, edit the chart), so that my chart isn't
    modified by an agent decision I haven't reviewed.
29. As a primary-care physician, I want the Co-Pilot to explicitly say
    when it can't ground a claim in the chart, so that I'm not handed an
    ungrounded answer presented as fact.
30. As a primary-care physician, I want the dashboard to load against
    real OpenEMR FHIR data via the standard FHIR R4 API, so that what I
    see matches what's in the chart everywhere else.
31. As an OpenEMR administrator, I want the redesigned dashboard to
    replace the existing Dashboard tab in the patient menu, so that
    physicians automatically get the new experience without retraining.
32. As an OpenEMR administrator, I want the legacy `demographics.php` to
    remain on disk as an unlinked fallback, so that I have a recovery
    path if a critical bug surfaces in the SPA.
33. As an OpenEMR administrator, I want the SPA registered as a
    pre-approved SMART confidential/PKCE client, so that physicians never
    see an OAuth consent prompt.
34. As an OpenEMR administrator, I want the SPA to refresh tokens
    silently using `offline_access` refresh tokens, so that physicians
    don't get bumped to login mid-encounter.
35. As an OpenEMR administrator, I want all dashboard data fetches scoped
    by SMART scopes (`patient/Patient.rs`, `patient/AllergyIntolerance.rs`,
    `patient/Condition.rs`, `patient/MedicationStatement.rs`,
    `patient/MedicationRequest.rs`, `patient/CareTeam.rs`,
    `patient/Observation.rs`), so that token leaks have a tightly bounded
    blast radius.
36. As a developer, I want the SPA to live in its own directory with its
    own `package.json` and Vite build, so that the OpenEMR Gulp pipeline
    isn't entangled with React tooling.
37. As a developer, I want the SPA bundle to deploy as a static asset
    inside the existing OpenEMR Docker image, so that there's no separate
    deploy target.
38. As a developer, I want a typed FHIR client returning Zod-validated
    DTOs (not raw FHIR resources), so that consuming code never has to
    handle malformed FHIR shapes at runtime.
39. As a developer, I want all server-state fetching to go through
    TanStack Query, so that caching, loading states, and refetch behavior
    are consistent across cards.
40. As a developer, I want the Co-Pilot dock to consume the existing
    AgentForge `/interface/agentforge/chat.php` SSE endpoint unchanged,
    so that the verification stack (citation grounding, clinical rules,
    LLM-judge) keeps working without modification.
41. As a developer, I want the agent's prompt updated to emit markdown
    `**bold**` around clinical values, so that the SPA can render bolded
    key values in answer bubbles without fragile client-side regex.
42. As a developer, I want a clear seam between the SPA's OAuth-bearer
    auth (for FHIR) and the dock's session-cookie auth (for chat.php), so
    that the dual-auth surface stays understood and intentional rather
    than accidental.

## Implementation Decisions

### Frontend stack

- **Framework:** React 19 + TypeScript, scaffolded via `npm create vite@latest`.
- **Build tool:** Vite 6+, output to OpenEMR's static asset directory so
  the existing Docker image serves the bundle.
- **Server state:** `@tanstack/react-query` for all FHIR fetches. The
  Co-Pilot SSE stream is *not* a TanStack Query — it's owned by a custom
  streaming hook.
- **Validation:** `zod` for parsing FHIR Bundle responses into typed DTOs
  at the network boundary.
- **Routing:** none. Single-screen dashboard; the surrounding tab bar
  (History, Assessments, etc.) is rendered by OpenEMR's existing PHP-side
  `PatientMenuRole` and is out of scope.
- **Testing:** `vitest` + `@testing-library/react` + `jsdom`, matching the
  testing conventions of the `agent/` sidecar.
- **Typography:** IBM Plex Sans + IBM Plex Mono via Google Fonts, loaded
  from the SPA's HTML shell.

### Auth & launch

- **Flow:** SMART on FHIR **EHR launch** with `launch/patient` scope. The
  Dashboard tab in `PatientMenuRole` triggers OpenEMR's existing
  `SmartLaunchController` to mint a launch token, which redirects to the
  SPA shell. The SPA performs the OAuth code exchange against
  `/oauth2/default/authorize` and `/oauth2/default/token`, receives an
  access token + bound `patient` claim, and renders.
- **Client type:** Pre-approved SMART client registered via
  `ClientAdminController`. Either a confidential client with a server-held
  secret + PKCE, or a public client with PKCE only. Pre-approval bypasses
  the consent prompt for all users.
- **Token refresh:** Silent refresh via `offline_access` refresh token,
  triggered before access-token expiry.
- **Hosting:** Same-origin (no third-party-cookie or SameSite issues).
- **Replacement strategy:** `PatientMenuRole`'s Dashboard link is rewired
  to the SMART launch URL. Legacy `demographics.php` stays on disk but is
  removed from the patient menu — an unlinked fallback that can be
  deleted in a follow-up once the SPA is stable.

### Data API surface

- **FHIR R4 only**, served from `/apis/default/fhir/*`. No reliance on the
  OpenEMR Standard REST API.
- **Card → resource mapping:**
  | Card | FHIR resource |
  |---|---|
  | Identity strip | `Patient` |
  | Allergies | `AllergyIntolerance` |
  | Problem List | `Condition` |
  | Medications | `MedicationStatement` |
  | Prescriptions | `MedicationRequest` |
  | Care Team | `CareTeam` |
  | Lab Results | `Observation?category=laboratory` |
- **Severity tinting on Allergies** maps `AllergyIntolerance.criticality`
  + `AllergyIntolerance.reaction.severity` to one of three buckets:
  *moderate* (red), *mild* (amber), *unknown* (grey).
- **Lab flagging** uses `Observation.interpretation` codes
  (`H`, `HH`, `L`, `LL`, `A`); no flag if the interpretation is absent.
  Reference ranges are *not* re-derived client-side.

### Co-Pilot dock

- **UI:** Native React component, rebuilt to match the brief's design
  tokens (IBM Plex, 360px width, 6px radius, brand-blue shadow,
  `#0d63c4` clinical chips / `#e0a325` document chips). Replaces the
  existing `<agent-sidebar>` Web Component.
- **Backend:** Unchanged — calls the existing
  `/interface/agentforge/chat.php` SSE endpoint via same-origin `fetch`.
  The browser sends the active OpenEMR session cookie automatically;
  `chat.php` reads `pid` from the session, mints the per-turn HS256
  patient-scoped JWT, and proxies the SSE stream from the Node sidecar.
- **Streaming:** SSE consumed via `fetch` + `ReadableStream` (or
  `EventSource`) inside a custom `useChatStream` hook. The hook emits
  incremental `{ summary, claims, followup_suggestions, confidence }`
  deltas as they arrive.
- **Answer rendering:** Single bubble per turn. The `summary` string
  (markdown-bold) is rendered as the bubble's prose. All
  `claim.citation_ids` from all claims are deduped and rendered as a
  flat chip row beneath. Per-claim severity is *not* surfaced in v1.
- **Citation chip resolver:** Pure function over the citation id prefix:
  `tool:` and `rule:` → clinical (blue), `doc:` → document (amber). Chip
  *labels* are fixed strings derived from the prefix in v1 ("Meds",
  "Labs", "Allergies", "Guideline", "Doc").
- **Markdown bold:** Agent prompt updated to instruct the LLM to wrap
  concrete clinical values in `**…**`. SPA renders markdown-bold via a
  small pure-function renderer (no full markdown parser).
- **Suggested next:** `followup_suggestions[]` from the answer schema
  (max 3). Click fills the input and submits.
- **Patient binding:** The dock's context pill binds to the SMART OAuth
  `patient` claim. The same patient identity is shared with the identity
  strip — both derive from the same SPA-level patient context.
- **Conversation persistence:** Ephemeral. The agent's in-memory
  conversation cache (30-min TTL, server-side) is the only persistence;
  page reload starts a fresh conversation.
- **Read-only:** The agent backend is already read-only; the SPA imposes
  no additional write surface.

### Card collapse persistence

- Stored in `localStorage`, keyed by `userId + pid + cardId`.
- Default open: all six clinical cards. No admin cards remain in scope
  (Demographics, Insurance, Billing dropped from the original brief
  list).

### Edit affordance

- Pencil icons on each card open the existing legacy PHP edit URLs in a
  new tab via `window.open(..., '_blank')`. Same-origin session cookie
  carries the user through. Edit page UX is unchanged and out of scope.
- Pencil clicks must `stopPropagation` so they don't toggle card collapse.

### Major modules (deep modules in **bold**)

1. **Auth / SMART launch hook** — encapsulates redirect handling, PKCE,
   OAuth code exchange, token storage, silent refresh. Exposes
   `useAuth()` returning `{ accessToken, patient, refreshing, error }`.
2. **FHIR client** — typed wrapper over `/apis/default/fhir/*` with one
   method per resource (`fetchPatient`, `fetchAllergies`, …). Handles
   header injection, FHIR Bundle pagination, and Zod parsing into DTOs.
3. Card-data hooks — thin TanStack Query layer atop (2). One per card.
4. **Clinical severity / lab-flag logic** — pure functions:
   `interpretAllergySeverity(criticality, reactionSeverity) → tint`,
   `interpretLabFlag(observation) → 'high'|'low'|'normal'`.
5. Card components — Allergies, Problems, Medications, Prescriptions,
   Care Team, Labs, plus the identity strip. Mostly presentational.
6. **Card collapse persistence hook** — `useCardCollapseState(cardId)`.
   Hides storage shape and key construction.
7. **`useChatStream` hook** — SSE consumer for `chat.php`. Owns
   `EventSource`/`ReadableStream` lifecycle, partial JSON accumulation,
   abort handling.
8. **Citation chip resolver** — pure function from citation id to
   `{ kind, label }`.
9. **Markdown-bold renderer** — pure split of `**…**` into React nodes.
10. Co-Pilot dock orchestrator + App shell — composition only.
11. Agent prompt update — instruct LLM to emit markdown bold around
    concrete clinical values.
12. `PatientMenuRole` modification — Dashboard tab now triggers SMART
    launch into the SPA.
13. Pre-approved SMART client registration (one-time setup via
    `ClientAdminController`).

## Testing Decisions

### What makes a good test

Tests verify external behavior at module boundaries — they assert what a
module *does*, not *how*. Pure modules get table-driven tests covering
representative inputs and edge cases. Hooks are tested through
`@testing-library/react`'s `renderHook`, asserting on the public return
value and side effects (storage writes, fetch calls), never on internal
state shape. Network-touching modules are tested against fetch mocks (or
MSW) seeded with realistic FHIR Bundle fixtures, including malformed
fixtures so Zod parsing failures are exercised.

Implementation details — internal state, private functions, render
counts — are off-limits. Card components and the dock orchestrator
deliberately have no unit tests; their behavior is covered by the
modules they compose.

### Modules covered by tests

| Module | Test surface |
|---|---|
| (1) Auth / SMART launch hook | OAuth code exchange happy path, token-refresh path, error path; `useAuth` returns expected states |
| (2) FHIR client | Each resource method against fixture Bundles; Zod parse failures; pagination; auth header injection |
| (4) Clinical severity / lab-flag logic | Table-driven over every `criticality` × `severity` combo and every `interpretation` code |
| (6) Card collapse persistence hook | Default state, persist on toggle, re-hydrate by `userId+pid+cardId` |
| (7) `useChatStream` hook | Mocked SSE stream emits incremental deltas; partial JSON accumulation; abort cancels the stream |
| (8) Citation chip resolver | Table-driven over each id prefix |
| (9) Markdown-bold renderer | Pure-function snapshot over a representative set of inputs (no bold, multiple bolds, nested-broken markdown) |

Card components, the dock orchestrator, and the App shell are excluded
from unit tests — they're shallow/presentational and their behavior
follows from the modules they compose.

### Prior art

- The `agent/` sidecar uses `vitest` extensively (`agent/tests/unit`,
  `agent/tests/integration`) — same conventions apply: arrange-act-assert,
  no implementation-detail assertions, fixture files alongside the test.
- The `agent/promptfoo/` directory holds the LLM-eval rubric for the
  prompt change in (11) — the markdown-bold prompt update should add a
  rubric assertion ("clinical numerics are markdown-bolded") rather than
  a unit test.
- Twig render fixture tests under `tests/Tests/Isolated/Common/Twig/`
  are the closest analogue for the SPA's HTML-output style; we won't
  copy their setup but the spirit (compare full output against a known
  fixture) translates to component-rendering snapshots.

## Out of Scope

- **Edit pages.** Allergies, Problems, Medications, Prescriptions, Care
  Team, and Lab Result *editing* flows continue to live in the existing
  legacy PHP pages. The dashboard's pencil affordances link out to those
  unchanged.
- **Other patient-menu tabs.** History, Assessments, Report, Documents,
  Document Inbox, Transactions are unchanged and continue to be rendered
  by `PatientMenuRole`.
- **Demographics, Insurance, Billing cards.** Dropped from the original
  brief's nine-card list. The redesign ships six clinical cards.
- **Vitals card.** The original design's "Vitals (NEW)" card is replaced
  by a Lab Results card as the brief's required +1 section.
- **Immunizations card.** Dropped — not in the agreed six-card scope.
- **Non-FHIR data sources.** No reliance on the OpenEMR Standard REST
  API. Anything not representable in FHIR R4 is excluded.
- **Cross-patient or population views.** Single-patient context only.
- **Co-Pilot write actions.** The agent remains read-only; no order
  placement, no chart edits via the dock.
- **Per-claim severity rendering in the dock.** The answer schema's
  `severity ∈ {info, attention, urgent}` is not surfaced visually in v1.
- **Conversation persistence across page reload.** The agent's 30-min
  in-memory cache is the only persistence.
- **Real-PHI deployment.** v1 is exercised against synthetic Synthea
  patient data. Real-PHI deployment requires a separate BAA review with
  the LLM vendor and is not part of this PRD.
- **Mobile / tablet layouts.** The 1400×1100 desktop viewport is the
  only target.
- **Internationalization of new SPA strings.** OpenEMR's `xl()` /
  `xlt()` legacy localization layer doesn't reach into the SPA. v1 ships
  English-only; i18n is a follow-up.

## Further Notes

- **Why React despite OpenEMR having no React infrastructure?** The user
  explicitly chose React over staying in Twig + SCSS, accepting the cost
  of standing up a fresh build pipeline. The SPA lives in its own
  directory with its own `package.json` to keep the existing Gulp
  pipeline untouched.
- **Why SMART OAuth despite the existing Co-Pilot using session cookies?**
  The user explicitly chose SMART OAuth as the SPA auth model ("we are
  supposed to use the OAuth2 tech"). The dual-auth surface — OAuth bearer
  for FHIR, session cookie for chat.php — is an accepted architectural
  seam. A future cleanup could refactor `chat.php` to also accept an OAuth
  bearer and unify auth, but that is not part of this PRD.
- **Why not reuse the existing `<agent-sidebar>` Web Component?** The
  user explicitly chose to rewrite it as a native React component for
  full design fidelity. The cost (re-implementing ~766 lines of streaming
  + citation logic) is accepted.
- **`followup_suggestions` cap mismatch.** The brief specifies up to 4
  "Suggested next" chips; the existing answer schema caps at 3. v1 uses
  3 to match the backend with no schema change required.
- **The legacy `demographics.php` stays on disk as a fallback.** This is
  a deliberate de-risking choice — the file can be deleted in a follow-up
  once the SPA has been observed in production for a soak period.
- **A1c, LDL, BP, dose values bolded in answers** depends on a small
  prompt change to the agent. The change should be paired with a
  `promptfoo` rubric assertion so off-spec model output is caught in the
  eval suite, not silently rendered without bolding.
- The patient used throughout the design mocks is **Margaret L. Chen**
  (DOB 1962-03-14, MRN 00012847). She corresponds to a Synthea-generated
  patient already seeded into the local OpenEMR instance.
