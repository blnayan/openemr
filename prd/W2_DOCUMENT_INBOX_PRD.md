# AgentForge Clinical Co-Pilot — Document Inbox PRD

**Status:** needs-triage
**Parent:** [W2_PRD.md](./W2_PRD.md)
**Companion:** [W2_ARCHITECTURE.md](../W2_ARCHITECTURE.md)

---

## Problem Statement

Today, an intake clerk who needs to attach a lab PDF or patient intake form
to a chart goes to the OpenEMR Documents tab, navigates a categorization
tree, picks the right "AgentForge — Lab PDF" or "AgentForge — Intake Form"
folder, and uploads. Extraction then fires asynchronously off a Symfony
event listener; the clerk has no in-place feedback that anything happened
beyond the file appearing in a folder. A reviewing clinician later
discovers extracted facts only because they trickle into the chart's
existing surfaces — there is no place to *see* what the VLM read, no way
to confirm or correct it before it round-trips into FHIR Observations,
and no way to view the page image with the bounding boxes that the schema
already captured. Lab values write through to FHIR the moment extraction
completes; if the VLM misreads a value, that error is on the chart before
any human has looked at it. Intake forms do not round-trip at all — the
clerk's effort lands in a sidecar table that no clinical surface reads.

The Documents-tab routing is fragile (a renamed category breaks the
listener) and the silent extraction step makes it impossible for a
clinician to trust the data on the chart without separately tracking
down the source PDF in another tab. The architecture also produces no
audit trail for human correction: the chart cannot distinguish a value
the VLM extracted from a value a human reviewed.

## Solution

A new patient-level surface called **Document Inbox** owns the upload,
extraction, review, and commit flow end-to-end. Clinical staff drag a
lab PDF or intake form onto the inbox, pick a doc type, and watch a
four-step stepper move from `uploaded → extracting → review → committed`.
When extraction completes, the page lands the user on a side-by-side
review screen: the document on one side (PDF.js for PDFs, native
`<img>` for images), every extracted field on the other, with bounding
boxes overlaid on the document and field-level tooltips on hover. The
clinician edits any value they need to correct, optionally rejects
individual rows (for labs) or the whole document, and clicks *Confirm*.
Only at that point do lab values round-trip into FHIR Observations and
intake medications/allergies/chief-concern round-trip into the standard
OpenEMR `lists` and `pnotes` surfaces. The chart records, for every
committed extraction, who confirmed it, when, and which fields the
human edited away from the VLM's output.

The inbox below the active jobs shows every previous upload for the
patient with status, doc type, and links to view either the source
document (in OpenEMR's canonical Documents tab — proving round-trip
integrity) or the read-only review of the extracted data. The
AgentForge document category in the OpenEMR Documents tab is removed,
along with the Symfony event listener that drove extraction off it;
extraction now flows through one explicit upload controller instead.

## User Stories

### Clinical staff (intake clerk)

1. As an intake clerk, I want to drop a PDF or image onto a Document
   Inbox tab on the patient's chart, so that the upload happens in one
   place dedicated to this workflow rather than the general Documents
   tab.
2. As an intake clerk, I want to pick whether the upload is a `lab_pdf`
   or `intake_form` at the moment of upload, so that the right schema
   is applied without auto-classification guesswork.
3. As an intake clerk, I want to see a four-step stepper (uploaded →
   extracting → review → committed) for every in-flight upload, so that
   I can tell whether the system is working on it, waiting on me, or
   done.
4. As an intake clerk, I want to upload several files in quick
   succession and see each as its own card with its own stepper, so
   that I do not have to wait for one to finish before starting the
   next.
5. As an intake clerk, I want oversized or wrong-MIME files to be
   rejected at the upload boundary with a clear message, so that I can
   correct and retry without guessing what went wrong.
6. As an intake clerk, I want a hard timeout to surface as a "still
   working — refresh to check" state rather than a frozen spinner, so
   that I am not blocked by a hung extraction.
7. As an intake clerk, I want every uploaded document to also appear in
   the canonical OpenEMR Documents tab via the same `documents` table,
   so that the chart's record of attached files is a single source of
   truth.

### Reviewing clinician

8. As a reviewing clinician, I want extraction to *not* round-trip into
   FHIR or `lists` until I have confirmed the values, so that a VLM
   misread cannot reach the chart without my eyes on it.
9. As a reviewing clinician, I want a side-by-side view of the source
   document and the extracted fields, so that I can verify each value
   in context without flipping between surfaces.
10. As a reviewing clinician, I want bounding boxes drawn over the
    document with field-name tooltips on hover, so that I can see at a
    glance which part of the page produced which extracted value.
11. As a reviewing clinician, I want each extracted value to be
    editable, but the bounding boxes to be locked, so that I can correct
    the VLM's reading without compromising the citation contract.
12. As a reviewing clinician, I want to reject individual lab rows (for
    a lab PDF) or reject the entire document, so that an extraction
    that is partly wrong does not force me into an all-or-nothing
    choice.
13. As a reviewing clinician, I want a single *Confirm* click to write
    every accepted lab row to FHIR Observations and every accepted
    intake medication/allergy to `lists`, so that I do not have to
    commit field-by-field.
14. As a reviewing clinician, I want a double-click on Confirm to be
    rejected by the server, so that a slow network cannot accidentally
    create duplicate FHIR rows.
15. As a reviewing clinician, I want pages of a multi-page document
    that the extractor did not process (because of the page cap) to be
    surfaced in the viewer with a "this page was not processed"
    overlay, so that I do not assume those pages are clean.
16. As a reviewing clinician, I want phone-photo intake forms with EXIF
    rotation metadata to display upright with bounding boxes aligned to
    what I see, so that the overlay is trustworthy regardless of how
    the document was captured.
17. As a reviewing clinician, I want post-commit edits to extractions
    to require deleting and re-uploading rather than in-place editing,
    so that committed FHIR records have a stable provenance.

### Auditor / second-reading clinician

18. As an auditor, I want every committed extraction to record who
    confirmed it and when, so that the chart attribution is unambiguous.
19. As an auditor, I want every field that a human edited away from the
    VLM's original output to be recorded as a JSON path list, so that I
    can filter the inbox to "human-corrected only" without diffing
    payloads.
20. As an auditor, I want each row of the inbox history to display a
    provenance badge (VLM-only vs human-corrected), so that I can spot
    extractions that were trusted as-is versus those that needed
    intervention.
21. As an auditor, I want a "View document" link on every history row
    that opens the source PDF or image in OpenEMR's canonical
    Documents-tab viewer, so that I can confirm that the source bytes
    live in the same store as every other patient document.
22. As an auditor, I want a "View extraction" link on every history row
    that opens the read-only review screen, so that I can audit the
    extracted fields and bounding boxes after commit.

### Site administrator

23. As a site administrator, I want the `patients/docs` ACL scope to
    govern who can see and use the Document Inbox tab, so that I do not
    have to manage a parallel permission model.
24. As a site administrator, I want upload and confirm endpoints to
    additionally require the write privilege on `patients/docs`, so
    that read-only roles can audit history but cannot mutate the chart.
25. As a site administrator, I want the AgentForge document category
    to be removed from the Documents-tab category tree on migration, so
    that clinicians do not have a confusing dead category alongside the
    new inbox.
26. As a site administrator, I want documents that previously lived
    under the AgentForge category to still be accessible in the
    Documents tab after migration, so that historical uploads remain
    queryable even though their category memberships are removed.
27. As a site administrator, I want the demo-fixture seeders to drive
    the new upload controller end-to-end (including auto-confirm), so
    that a fresh deploy boots into a state where the inbox shows real
    committed extractions for the demo patient without manual clicks.

### Compliance / security reviewer

28. As a security reviewer, I want all extracted document text and
    bounding-box payloads to remain server-side in the sidecar and be
    served only to authenticated requests scoped to the patient's
    `pid`, so that PHI never appears in URL parameters or
    cross-origin payloads.
29. As a security reviewer, I want the doc-bytes and page-image
    endpoints to set `Cache-Control: private, no-store`, so that PHI
    cannot persist in shared browser caches.
30. As a security reviewer, I want the inbox page to never embed
    extracted text in DOM `data-*` attributes or `console.log`, so
    that page screenshots in shared SaaS tools (e.g. Slack) cannot leak
    PHI through browser DevTools.
31. As a security reviewer, I want the existing PHI redactor to be
    extended to cover the new provenance fields if any are sent to
    LangSmith, so that adding new traced fields cannot silently leak
    PHI.
32. As a security reviewer, I want the upload endpoint to enforce the
    same MIME and size whitelist that the legacy listener enforced, so
    that the rework does not regress the file-validation surface.

### Eval owner / grader

33. As the eval owner, I want the existing five-rubric eval suite to
    continue to pass after the rework with no rubric regression beyond
    the committed delta, so that the rework can be merged without
    re-baselining.
34. As the eval owner, I want the new `IntakeWriter` round-trip path to
    be exercised by an integration test that proves intake medications
    and allergies appear in `lists` after confirm, so that the new
    write path is not silently broken by a future change.
35. As a grader, I want the inbox history to make it visible at a
    glance that source bytes round-trip through OpenEMR's canonical
    `documents` table, so that I can verify the FHIR/OpenEMR-integrity
    requirement without code reading.
36. As a grader, I want the bounding-box overlay viewer to be the same
    surface that lives behind every "View extraction" link, so that
    the citation contract is reachable from any inbox row, not buried
    in a separate page.

### Developer (future-proofing)

37. As a developer, I want a single PHP enum to encode the upload-job
    state machine, so that PHPStan level 10 catches every typo'd state
    string at static-analysis time.
38. As a developer, I want a single `ConfirmCommitter` service to be
    the only path from a sidecar to a FHIR/OpenEMR write, so that no
    future controller can accidentally commit by going around it.
39. As a developer, I want lab values written via `LabFhirWriter` and
    intake values written via the new `IntakeWriter` to share the
    same `agentforge_resource_links` provenance pattern, so that the
    audit table is uniform across doc types.
40. As a developer, I want the legacy event listener and AgentForge
    document category to be removed in the same change as the new
    inbox lands, so that there is exactly one path into extraction
    rather than two.
41. As a developer, I want the bounding-box overlay rendering math to
    derive every overlay coordinate from the captured `image_w`/`image_h`
    on each bbox rather than from PDF metadata, so that the
    `MAX_PIXELS_PER_PAGE` server-side downscale does not silently
    misalign overlays on poster-sized pages.
42. As a developer, I want the agent service's image renderer to bake
    EXIF orientation into the rendered PNG before recording image
    dimensions, so that bounding-box coordinates are in the same space
    as what the browser displays.
43. As a developer, I want the IntakeFormSchema header comment that
    declares "sidecar-only — no write-through" to be updated to reflect
    the new partial write-through, so that future readers do not infer
    a stale design rule.

## Implementation Decisions

### New top-level patient menu surface

- A new **Document Inbox** entry is added to the patient menu as a
  sibling of Dashboard, History, Documents, etc. It is not embedded as
  a card on the existing dashboard.
- The menu entry is gated by the existing `patients/docs` ACL scope.
  Server-side endpoints additionally require the write sub-privilege
  for upload, confirm, and reject actions.
- The page has three implicit modes: **idle** (drop zone + history
  list), **active** (top strip of in-progress stepper cards + history
  list), and **reviewing** (full-width side-by-side document viewer +
  extracted-fields panel).

### Backend split: extract-only dispatcher + confirm gate

- The existing `ExtractionDispatcher` is split. After this change it
  performs extraction and sidecar persistence only — it no longer
  invokes any FHIR writer.
- A new `ConfirmCommitter` service is the only path from a sidecar row
  into a FHIR or OpenEMR write. Given a `(job_uuid, edited_json,
  user_id)` it routes to `LabFhirWriter` or to a new `IntakeWriter`
  based on the doc type recorded on the sidecar, stamps provenance,
  and transitions the upload job to a terminal state.
- A new `IntakeWriter` mirrors `LabFhirWriter`'s shape. It writes
  intake current-medications and allergies to OpenEMR's `lists` table
  and the chief-concern field to `pnotes`. It emits a row in
  `agentforge_resource_links` for every written record so audit
  parity with labs is preserved. Demographics merge and family-history
  round-trip are explicitly out of scope; both are flagged as future
  extensions because they would overwrite or duplicate clinically
  authoritative data.

### Upload entry point and listener removal

- A new `UploadController` is the single HTTP entry point for both lab
  PDFs and intake forms. It accepts a multipart upload, validates MIME
  and size, calls OpenEMR's `Document::createDocument()` to persist
  source bytes in the canonical `documents` table, inserts the
  upload-job and sidecar rows, and dispatches extraction.
- Doc type travels as an explicit form field on the upload, not as a
  category-name substring match. The legacy
  `DocumentExtractionSubscriber`, its Symfony bootstrap registration,
  the substring-based category routing, and the AgentForge document
  category itself are removed.
- A migration deletes the AgentForge category rows, untags any
  documents previously associated with that category, and repairs the
  `categories` nested-set tree. Documents are not deleted — a
  previously-uploaded PDF remains accessible in the Documents tab,
  just without a category badge.

### State machine and progress UI

- A new PHP enum encodes the upload-job state machine with six values
  (`pending`, `extracting`, `ready_for_review`, `committed`,
  `rejected`, `failed`). Every persistence write goes through the
  enum so PHPStan level 10 catches typos.
- The progress UI is a four-step stepper (`uploaded → extracting →
  review → committed`), not a percentage bar. Active jobs poll the
  status endpoint every 1.5 seconds while in `pending` or
  `extracting`. Polling stops on terminal states or on
  `ready_for_review` (which hands off to user action). A 90-second
  client-side timeout in `extracting` produces a "still working —
  refresh to check" state.
- The schema's existing `progress_pct` and `progress_message` columns
  on the upload-jobs table are not used by the new flow but are not
  dropped, to avoid a destructive migration.

### Review screen behavior

- Extracted values are editable; bounding boxes are not. Edits diff
  against the original VLM output to populate a JSON path list of
  changed fields. The list is persisted as a new column on the sidecar
  alongside the reviewer's user id and timestamp.
- Per-row reject is supported for lab PDFs at the granularity of a
  single test row. Whole-document reject is supported for both doc
  types and produces a terminal `rejected` state with no FHIR writes.
- A double-click on Confirm receives an explicit `409` from the server
  (the strict-status invariant that the upload-job is in
  `ready_for_review` is enforced) rather than being made idempotent.
  This keeps `LabFhirWriter` and `IntakeWriter` free of "what if I
  already wrote this?" branching.
- Post-commit editing is out of scope for this PRD; the user must
  delete the document in the standard surface and re-upload to revise
  a committed extraction.

### Bounding-box overlay rendering

- For PDFs, the page is rendered client-side with PDF.js using
  `useSystemFonts:false` for parity with the agent service's
  server-side renderer. The agent's renderer uses the same library;
  the overlay's coordinate system therefore matches without any
  server-side rendering surface added.
- For PNG/JPEG/WebP uploads, the client renders the original document
  bytes via a native `<img>` element.
- Overlay coordinates are always derived as `displayedScale =
  clientCanvasWidth / bbox.image_w` and applied to `(x, y, w, h)`.
  This keeps overlays aligned even when the server-side renderer
  downscales a poster-sized page below the default 2.0× scale.
- The agent service's `PageRenderer` is updated to bake EXIF
  orientation into rendered images before recording dimensions, so
  phone-photo uploads with rotation metadata do not misalign their
  overlays.

### Schema migrations

- Four new columns on the sidecar table: a foreign key to the
  reviewing user, a review timestamp, a review-decision enum, and a
  JSON column listing the JSON paths the reviewer edited.
- A new migration deletes the AgentForge category and its children,
  untags affected documents, and repairs the `categories` nested-set
  invariants.
- No new tables are introduced. The existing `agentforge_upload_jobs`,
  `agentforge_document_extractions`, and `agentforge_resource_links`
  tables carry the rework.

### History pane

- The inbox shows in-progress uploads above the history list when
  any are present.
- The history list is a sortable table with columns for filename,
  doc-type badge, uploaded-by + relative time, color-coded status,
  and per-row actions: open the source document in the canonical
  Documents tab, open the read-only review of the extracted data,
  and (for `ready_for_review` rows) open the editable review.
- A provenance filter chip lets the auditor narrow to "human-corrected
  only," matched by the `edited_field_paths` column being non-empty.

### Cache and PHI posture

- Endpoints that serve document bytes or page images set
  `Cache-Control: private, no-store`.
- The page does not embed extracted text or bounding-box payloads in
  DOM `data-*` attributes or `console.log`. State lives in component
  memory and disappears on navigation.
- The existing `PhiRedactor` serializer is extended if any new
  provenance fields are added to LangSmith trace payloads, preserving
  the no-escape-hatch invariant.

### Demo and fixture impact

- The fixture seeder scripts that previously uploaded through the
  Documents-tab path are updated to call the new upload controller and
  auto-confirm with a synthetic system reviewer, so a fresh Railway
  deploy boots into a state where the demo patient already has
  committed extractions visible in the inbox.
- The setup guide and W2 architecture document are updated to drop
  references to the AgentForge category and the event listener, and
  to describe the new flow.

### Minor agent-service changes

- The existing comment on `IntakeFormSchema` declaring intake forms
  "sidecar-only" is updated to reflect the new partial write-through
  to `lists` and `pnotes`. The Zod schema itself does not change.
- The agent service has no new endpoints. The only behavioral change
  on that side is the EXIF rotation fix on the page renderer.

## Testing Decisions

### Test posture

A good test for this codebase exercises external behavior — a public
function's input/output contract or an HTTP boundary's response — and
does not bind to implementation details. Tests that snapshot internal
state or call private helpers create churn whenever the implementation
evolves; tests that exercise the public interface stay stable across
refactors and remain useful evidence that the contract holds. Prior
art: the existing PHP `Isolated` tests under
`tests/Tests/Isolated/AgentForge/` (sidecar persister, lab adapter)
exercise the public surface of those services without a database; the
agent service's Vitest suite does the same on the TypeScript side.
The Week 2 promptfoo suite is the prior art for end-to-end behavioral
tests with deterministic JS rubric assertions.

### Modules with isolated tests

- **`EditedFieldPathDiffer`** — pure function over two JSON values;
  exhaustive coverage of nested objects, arrays, primitive changes,
  array-element insertion and deletion, and equal-but-reordered
  arrays. No I/O, no database; matches the agent service's pure-utils
  test posture.
- **`UploadJobStatusMachine`** — closed enum × closed transitions; the
  test matrix is finite and small. Covers every legal transition,
  every illegal transition (which must throw a typed exception), and
  the terminal-state property (`committed`, `rejected`, `failed`
  reject all further transitions).
- **`IntakeWriter`** — round-trip integrity tests proving that an
  intake schema instance produces the expected `lists` rows with
  correct types (`medication`, `allergy`), the expected `pnotes`
  insert for chief concern, and one `agentforge_resource_links` row
  per write. Failures in any sub-write are tested for the partial-
  success contract: the upload-job records partial success but other
  rows still write. Mirrors the existing `LabFhirWriter` test shape.
- **`ConfirmCommitter`** — orchestration tests covering: doc-type
  routing to the right writer, double-confirm rejection with a `409`,
  status transitions on success and failure, provenance stamping on
  the sidecar (reviewer id, timestamp, edited path list).
- **`DocumentInboxQueryService`** — query correctness against a fixture
  database. Covers grouping (active vs history), status filtering,
  provenance-filter behavior, and ordering.
- **`BboxOverlay`** — the React component's scaling math is the part
  under test. Covers landscape and portrait pages, EXIF-rotated images
  whose `image_w`/`image_h` match the rotated dimensions, the
  poster-page downscale case where `image_w` is smaller than 2× the
  PDF page width, and bbox coordinates clipped to the canvas. Mounted
  with jsdom; no real PDF.js render is exercised.

### Modules without isolated tests

The HTTP controllers (`UploadController`, the job-status / confirm /
reject endpoints, and the inbox page controller) are tested through
HTTP-level integration tests against a real database fixture, not
through unit tests of the controller class. Frontend page-level
components are exercised end-to-end rather than through mount tests,
because the unit-mount cost is high and the value low for components
whose work is composing smaller pieces.

The `UploadJobStatus` enum has no behavior to test on its own; its
coverage comes from any module that uses it.

### Eval-suite contract

The existing five-rubric eval suite and its 65-case fixture set must
continue to pass after the rework. The rework does not introduce new
eval cases — but a new HTTP-level integration test asserts that intake
extractions, after confirm, appear as queryable rows in `lists` for
the `getMedications` and `getAllergies` Week 1 tools, closing a gap
that previously existed between extraction and chat-time visibility.

## Out of Scope

- **Streaming / progressive extraction.** The review screen waits for
  extraction to complete; field-by-field streaming as the VLM emits
  partial output is not built.
- **Post-commit editing of FHIR records and `lists` rows.** Once a
  user has confirmed an extraction, correcting a field requires
  deleting the document and re-uploading. FHIR versioning, audit-trail
  RBAC for amendments, and an in-place edit affordance on the inbox
  are deliberately deferred.
- **Demographics merge from intake forms.** Self-reported demographics
  parsed from an intake form are not merged into `patient_data`.
  Family-history round-trip into `history_data` is also out of scope.
  Both are politically sensitive write paths that would need a critic
  agent or a human-gated reconciliation surface before they could be
  enabled.
- **Wrong-patient name match and injection regex scan.** The PRD's
  parent W2 PRD scopes both. Neither is implemented today and neither
  is added by this rework. The sidecar columns continue to record
  default values.
- **Critic agent.** Listed in the parent W2 PRD as out of scope; the
  human-in-the-loop confirm gate is the equivalent safety layer for
  this rework.
- **Bounding-box editing.** Reviewers can correct the value but not
  the bounding-box coordinates. Bbox provenance must remain a faithful
  record of what the VLM produced.
- **Replacing the stepper with a real percentage progress bar.** The
  agent service does not emit per-stage progress and synthesizing a
  percentage from time elapsed would be theatrical. The four-step
  stepper is honest about progress.
- **Re-extraction of legacy uploads.** Documents that were uploaded
  via the now-removed Documents-tab listener path before this rework
  retain their existing sidecar rows; they are not re-extracted, and
  they are not visible in the new inbox unless their existing job row
  is migrated. Migration of legacy job rows into the new state machine
  is treated as a separate concern.

## Further Notes

This PRD is downstream of a multi-question design review captured in
the conversation that produced it. A few decisions deserve highlight
because they trade scope for safety and will be the most likely topics
of grader probing:

- **The deferred-commit gate is the structural defense against VLM
  misreads.** Lab values do not appear on the chart until a human has
  reviewed them. This is stronger than the parent W2 PRD's planned
  crop-and-verify second pass (which was scope-cut). It does, however,
  introduce a workflow step that the parent PRD did not require, and
  the demo video must show the review-and-confirm step or the value of
  the design is invisible to graders.
- **Round-trip integrity is preserved by routing all uploads through
  `Document::createDocument()`.** Even though the entry point moves
  from the Documents tab to the new inbox, the source bytes still land
  in OpenEMR's canonical `documents` table. The "Open in canonical
  Documents tab" link on every history row is the visible proof that
  no parallel object store exists.
- **The bounding-box overlay closes the largest gap named in
  W2_ARCHITECTURE.md §12.1.** That document calls out the missing
  overlay viewer as the parent PRD's largest material gap. This PRD
  delivers it as the primary review surface — the data has been in the
  schema since Week 2 issue 02; what was missing was the UI that reads
  it.
- **`IntakeWriter` partially closes W2_ARCHITECTURE.md §12.2** by
  routing intake medications and allergies into `lists`. It does not
  close the lab-value risk because labs continue to write to FHIR via
  `LabFhirWriter` — but it does so only after human confirm, which is
  the Lab side's structural defense.

The companion artifact for grader review is the updated
[W2_ARCHITECTURE.md](../W2_ARCHITECTURE.md), which describes the
post-rework architecture end-to-end and retains the honest scope-cut
accounting against the parent W2 PRD.
