# AgentForge Clinical Co-Pilot — Week 2 PRD

## Problem Statement

A primary care physician preparing for a follow-up visit has structured data
in OpenEMR, but the recent information that drives the visit is buried in
documents the staff just uploaded — a scanned lab PDF, a hand-completed
intake form. The physician opens the AgentForge chat, asks "what changed and
what should I pay attention to?", and the agent has nothing to say about the
documents because it cannot read them. Worse, when the physician asks for
guideline-grounded answers ("is this A1c at goal?"), the agent has no
trustworthy way to cite *why*.

The Week 1 agent reads structured OpenEMR data well, but it is blind to the
inputs clinicians actually receive in the real world: scanned PDFs, intake
forms, faxes. Without a way to see those documents and a way to ground its
answers in clinical guidelines, the agent stops being useful at the exact
moments it should help most.

## Solution

Add two new capabilities to the AgentForge Clinical Co-Pilot:

1. **The agent can see clinical documents.** Staff upload a lab PDF or
   intake form to a patient's chart through a new dashboard widget. The
   document is rendered, read by a vision language model into a strict
   schema, every extracted field carries a bounding-box citation back to
   the source page, and lab values round-trip into FHIR Observations so they
   appear everywhere else on the chart.

2. **The agent routes work across a small inspectable graph and grounds
   every answer.** A supervisor sits above three workers — an
   intake-extractor that returns extracted document data, an
   evidence-retriever that searches a small clinical-guideline corpus with
   hybrid retrieval and reranks, and a clinical-data worker (the existing
   Week 1 graph). Every claim in the final answer carries a machine-readable
   citation pointing to a document field, a guideline section, or a chart
   tool result.

Quality is gated by a 50-case golden-set eval suite with deterministic
boolean rubrics that runs as a PR-blocking GitHub Action. Observability runs
through LangSmith with PHI redaction on every payload that leaves the box.

## User Stories

### Primary care physician (chat consumer)

1. As a physician, I want to ask "what changed and what should I pay
   attention to?" for a patient and receive a grounded answer that combines
   chart data, recent uploads, and guideline evidence, so that I can prep
   for a follow-up visit faster than reading three separate places.
2. As a physician, I want every clinical claim in the agent's answer to
   carry a citation I can click, so that I can verify the source before I
   act on the recommendation.
3. As a physician, I want the agent to refuse to answer when it cannot
   ground a claim instead of fabricating a value, so that I can trust silence
   as much as a confident answer.
4. As a physician, I want guideline citations to quote the relevant sentence
   verbatim from the named source, so that I can paraphrase confidently in
   my note.
5. As a physician, I want the agent to surface that an uploaded document's
   patient name does not match this chart, so that I do not unknowingly act
   on data from another patient.
6. As a physician, I want the agent to handle multi-turn follow-ups about a
   document I just uploaded, so that I can drill into specifics without
   re-explaining context.
7. As a physician, I want the agent to cleanly distinguish patient-record
   facts from guideline evidence in its answer, so that I can tell what came
   from the chart versus what came from a recommendation.

### Clinical staff (document uploader)

8. As an intake clerk, I want to drop a PDF or image of a lab report or
   intake form onto the patient dashboard widget, so that the document is
   attached without leaving the chart.
9. As an intake clerk, I want to choose whether the upload is a lab PDF or
   an intake form at upload time, so that the right schema is applied.
10. As an intake clerk, I want to see real-time progress while the document
    is being read (rendering, extracting, verifying, persisting), so that I
    know the system is working and roughly when it will finish.
11. As an intake clerk, I want to be told plainly when an upload fails (bad
    file type, oversized file, extraction error), so that I can correct and
    retry without guessing.
12. As an intake clerk, I want a warning banner on the upload row when the
    document's patient name does not match the chart, so that I can
    double-check before relying on it.
13. As an intake clerk, I want uploaded documents to also appear in the
    existing Documents tab, so that the chart's record of attached files
    remains a single source of truth.

### Reviewing clinician (citation auditor)

14. As a reviewing clinician, I want to click any citation that points to an
    uploaded document and see the page rendered with the cited field
    highlighted by a bounding box, so that I can verify the value was really
    on the document.
15. As a reviewing clinician, I want the bbox overlay viewer to show me the
    list of every extracted field for a document with click-to-source
    linking in both directions, so that I can audit a whole intake form
    without paging through manually.
16. As a reviewing clinician, I want fields whose values could not be
    cross-checked against the document image to be visibly marked as
    low-confidence or disputed, so that I review them with appropriate
    skepticism.

### Site administrator (deployment)

17. As a site admin deploying AgentForge, I want every required environment
    variable documented with a one-line purpose and a `.env.example` file,
    so that I can stand up a new environment without reverse-engineering.
18. As a site admin, I want guideline-corpus ingest and demo-fixture ingest
    to run idempotently on Railway boot when env-gated, so that fresh
    deploys are fully usable without manual one-shot commands.
19. As a site admin, I want the AgentForge tables created through the
    standard OpenEMR migration framework, so that fresh installs work the
    same way as for any other OpenEMR feature.
20. As a site admin, I want a single AgentForge Documents category in
    OpenEMR's existing categorization, so that I can apply normal document
    permissions and search.

### Eval owner (CI gatekeeper)

21. As the eval owner, I want a 50-case golden set covering extraction,
    evidence retrieval, multi-source synthesis, refusal, anti-hallucination,
    PHI-leak detection, and wrong-patient detection, so that I can detect
    quality regressions before they merge.
22. As the eval owner, I want every rubric assertion to be a deterministic
    JavaScript check rather than an LLM judge, so that pass/fail outcomes
    are reproducible and actionable.
23. As the eval owner, I want absolute pass thresholds and a regression
    delta against a committed baseline, so that the build fails when a
    rubric drops below an acceptable floor or regresses by more than five
    percentage points.
24. As the eval owner, I want the PR-blocking gate to live in CI rather than
    a local pre-push hook, so that contributors cannot bypass it with
    `--no-verify`.
25. As the eval owner, I want extraction-bucket eval cases to read from
    pre-extracted JSON committed alongside the fixture PDFs rather than
    re-running the VLM, so that eval runs are deterministic and cheap.
26. As the eval owner, I want the eval baseline file to be promoted via an
    explicit pull request rather than auto-updated, so that quality drift
    cannot sneak in.
27. As the eval owner, I want a small ingest smoke suite that runs the live
    extraction pipeline end-to-end on a handful of fixtures, so that I catch
    breakage in the pipeline itself even when the deterministic suite passes.
28. As the eval owner, I want graders to be able to trigger a deliberate
    regression and confirm the build fails, so that the gate's value is
    independently verifiable.

### AgentForge developer

29. As a developer, I want the supervisor's worker handoffs to appear as
    parent/child runs in LangSmith, so that I can read a chat turn as a
    decision tree.
30. As a developer, I want a single deep extraction-pipeline interface that
    takes file bytes plus a doc type and returns strict-schema JSON plus
    sidecar metadata, so that the rest of the system never has to think
    about VLMs, OCR, or image rendering.
31. As a developer, I want a single hybrid-retriever interface that takes a
    query and returns ranked guideline chunks, so that the supervisor never
    has to know about Pinecone, BM25, RRF, or rerank directly.
32. As a developer, I want lab and intake schemas to carry an explicit
    `schema_version` discriminator from day one, so that I can evolve the
    schema without breaking existing sidecar rows.
33. As a developer, I want the verifier to drop unverifiable claims from
    the final response rather than mark them, so that the answer the user
    sees is structurally sound regardless of model behavior.
34. As a developer, I want a single PHI redactor wrapping the LangSmith
    client with no escape hatch, so that adding a new traced field cannot
    silently leak PHI.
35. As a developer, I want the supervisor to receive an availability hint
    listing what documents and corpus sources exist before deciding which
    workers to call, so that routing decisions are informed but still
    visibly the supervisor's call.
36. As a developer, I want bootstrap failures to be logged but not block
    server start, so that one bad fixture cannot take down the deployed app.
37. As a developer, I want every external provider call (VLM, embedding,
    rerank, vector query) wrapped with a cost-tagged child run, so that the
    cost report can be generated from LangSmith without a parallel local
    metrics table.

### Compliance / security reviewer

38. As a security reviewer, I want indirect prompt-injection patterns
    embedded in extracted document text to be flagged and replaced with a
    redacted marker in chat context while the verbatim value remains
    visible only on the bbox overlay viewer, so that the LLM cannot be
    influenced by document content but a human can still read it.
39. As a security reviewer, I want every payload sent to LangSmith to pass
    through the redactor that loads the request's PHI set from the
    JWT-bound patient identity, so that PHI cannot leak into observability.
40. As a security reviewer, I want uploaded files restricted to a small
    allowlist of MIME types and a sane size cap, so that obviously wrong
    inputs are rejected at the boundary.
41. As a security reviewer, I want the SSE upload-progress endpoint to
    enforce that the requester has access to the underlying document, so
    that job IDs cannot be used to discover progress on other patients'
    uploads.
42. As a security reviewer, I want existing OpenEMR document ACLs to be the
    only authorization mechanism for uploads, so that there is no parallel
    permission model to keep in sync.
43. As a security reviewer, I want the eval suite to include cases that
    verify no PHI appears in captured traces and that injection attempts
    are not complied with, so that these protections are continuously
    tested rather than reviewed once.
44. As a security reviewer, I want the supervisor's synthesis prompt to
    structurally separate document content from instructions via
    delimiters, so that the model has a baseline reason to ignore embedded
    instructions even before pattern scanning runs.

### Architecture defense audience (graders)

45. As a grader, I want a Week 2 architecture document at the repo root
    that walks the system end-to-end and includes an honest risks/trade-offs
    section, so that I can evaluate whether the team has thought
    adversarially about their own design.
46. As a grader, I want the Week 1 baseline behavior to be cleanly
    distinguishable from the Week 2 multimodal behavior in the README and
    the deployed app, so that I can judge what was newly built.
47. As a grader, I want a publicly accessible deployed app with the Week 2
    core flow working out of the box, so that I can reproduce the demo
    without local setup.
48. As a grader, I want a cost and latency report covering actual dev
    spend, projected production cost, p50/p95 latency, and a bottleneck
    analysis, so that I can evaluate whether the build is operationally
    serious.
49. As a grader, I want the 50-case eval suite, the rubric definitions,
    the baseline file, and the CI workflow to be reviewable in source, so
    that the gate is auditable and not just claimed.
50. As a grader, I want a 3–5 minute walkthrough video that shows upload,
    extraction, the bbox overlay, a multi-source synthesis answer, a
    refusal, the eval gate catching a deliberate regression, and an
    observability trace, so that I can verify each capability in a single
    artifact.

## Implementation Decisions

### Architectural posture

- **Extraction happens at upload time.** A single VLM-driven pipeline runs
  when the document is uploaded; chat-time workers read pre-extracted data
  rather than re-running the VLM. Determinism for the eval gate, sub-second
  chat-time lookups, and a single place where bbox metadata is captured.
- **Single-pass extraction via OpenRouter.** A document VLM (Qwen 2.5 VL
  at MVP, chosen for its bbox-grounding training since the architecture
  has no OCR backstop) is invoked through the existing OpenAI-compatible
  client pointed at OpenRouter; no new SDK. The exact OpenRouter model
  slug is pinned in env — never tracked as `latest`.
- **Two trust signals on every extracted field.** The VLM emits a per-field
  confidence; a crop-and-verify second pass crops the page to each field's
  bbox and asks a narrower VLM call to confirm the value. Sidecar records
  `verified | disputed | low_confidence | unverifiable`.
- **Bbox coordinates live in image-pixel space.** Page PNGs are the rendered
  surface for the overlay viewer; the original PDF coordinate system is
  intentionally avoided.

### Storage and persistence

- **Three storage layers.** Source bytes go to OpenEMR's existing
  `documents` table via `DocumentService` under a new `AgentForge` category.
  Lab values write through to FHIR Observation via existing OpenEMR
  services so they appear in chart trends and Week 1 tools. Sidecar table
  carries extracted JSON, bbox metadata per field, and citation provenance.
- **Intake form data is sidecar-only.** Allergies, current meds, family
  history, and chief concern from intake forms do not write through to
  `lists` or `prescriptions`. The intake-extractor worker is the canonical
  path to that data.
- **Schema versioning from day one.** A `schema_version` column on the
  sidecar discriminates which Zod parser applies; old rows keep their
  original version; an opt-in re-extraction script upgrades rows when a
  schema is bumped.
- **All schema changes via Doctrine Migrations.** Two new tables (sidecar
  for extractions, upload-job state for SSE), one new document category.
  Indexes for chat-time lookup, latest-by-patient lookup, and SSE polling.

### Schemas

- **Lab schema.** Document-level header (performing lab, ordering provider,
  default collection date, patient-name on document) plus a list of
  result rows. Each result row carries test name, optional LOINC code,
  numeric and display values, optional unit, structured reference range
  with a raw-text fallback, FHIR-aligned abnormal flag enum, optional
  collection date overriding the header default, bbox, VLM confidence, and
  citation confidence.
- **Intake schema.** Self-reported demographics (no auto-reconciliation
  with the chart at extraction time), nullable chief concern, list of
  intake medications with structured fields, list of allergies with
  optional severity enum, list of family-history entries with a relation
  enum and a list of conditions per relation. Every atomic field carries a
  bbox.
- **Citation contract.** Discriminated union over three source types:
  `patient_document` (with bbox and citation_confidence), `guideline` (with
  pinecone chunk id and rerank score), and `patient_record` (preserving
  Week 1's `tool:<name>:row-<n>` form). Every claim in the final answer
  carries at least one citation; guideline citations carry a quoted span
  rather than the full chunk body.

### Hybrid retrieval

- **Corpus.** Four sources: ADA Standards of Care relevant sections,
  AHA/ACC Hypertension Guideline, USPSTF screening recommendations, KDIGO
  CKD guideline. Total ~50–250 chunks.
- **Structural chunking.** Each numbered recommendation or named subsection
  is one chunk with stable, human-readable section identifiers. Soft cap
  at ~800 tokens for unusually large sections.
- **Pipeline.** Pinecone Inference (`llama-text-embed-v2`) for dense
  embeddings — raw text is sent at ingest and at query time, Pinecone
  embeds server-side. In-process BM25 for sparse. RRF fusion of top-K
  from each, then Pinecone Inference rerank (`cohere-rerank-3.5` with
  `bge-reranker-v2-m3` as a configurable fallback) over the fused list.
  Top-5 reranked chunks returned with chunk id, source name, section
  identifier, body, and score.
- **Index naming.** Versioned (`agentforge-guidelines-v1`); a re-chunking
  strategy change requires a new version, not a poisoned existing index.

### Supervisor and worker graph

- **Pattern.** Supervisor sits above three workers: intake-extractor,
  evidence-retriever, clinical-data (the Week 1 graph wrapped). The Week 1
  router/planner/verifier/formatter become the body of the clinical-data
  worker.
- **Routing.** Reactive with availability hint. Supervisor receives a thin
  metadata list at turn start (what documents exist, what corpus sources
  are available, whether any documents have a patient-mismatch warning),
  then chooses which workers to call based on the question.
- **Fan-out.** Serial; one worker call at a time; loop cap of six handoffs
  before forced synthesis. Each handoff is a child LangSmith run with
  inputs, outputs, and latency.
- **Synthesis at the supervisor level.** The verifier and formatter run
  above all three workers, not inside clinical-data. Verifier is
  fail-closed: claims with unverifiable citations are dropped from the
  response; if too many are dropped, the response degrades to a low-confidence
  refusal.

### Upload UX

- **Surface.** A drag-drop widget on the patient dashboard. The file goes
  through `DocumentService` to the `AgentForge` category so it also
  appears in the existing Documents tab.
- **Doc type selection.** User picks `lab_pdf` or `intake_form` at upload
  time. No auto-classification.
- **Progress.** Server-Sent Events keyed by an upload-job id; events are
  `rendering`, `extracting`, `verifying`, `verifying_patient_match`,
  `persisting`, `done`, or `failed`. An upload-jobs table holds state.
- **Auth.** Existing OpenEMR document ACL plus the JWT-bound `pid` check
  the agent service already does for chat. No parallel permissions.
- **File validation.** MIME-type/extension allowlist (`application/pdf`,
  `image/png`, `image/jpeg`, `image/webp`) and a 10 MB size cap. Anything
  else is rejected at the upload endpoint.
- **Bbox overlay viewer.** A separate page renders page PNGs with bbox
  overlays and a side panel listing every extracted field; click-to-source
  linking in both directions.

### Wrong-patient detection

- **Match scope.** Patient name only; no DOB, no MRN.
- **Algorithm.** Lowercase, strip punctuation, drop middle initials,
  collapse whitespace, token-set comparison; pass if either token set is a
  subset of the other.
- **Failure mode.** Warning only, never a hard block. Sidecar records
  `match | mismatch | unverifiable`. The dashboard upload row shows a
  banner on mismatch; the supervisor's availability hint surfaces the
  warning at chat time so synthesized answers cite a flagged document with
  a caveat.

### Security

- **PHI redaction.** Hybrid: structural fields (tool names, latencies,
  citation ids, token counts) ship verbatim; body fields go through a
  redactor wrapping the LangSmith client. The redactor loads the request's
  PHI set from the JWT-bound `pid`. There is no escape hatch.
- **Indirect prompt injection.** Three layers: the supervisor's system
  prompt structurally separates document content from instructions via
  delimiters; the verifier's 100% factually_consistent floor means an
  injection-induced response would have no resolvable citations and be
  dropped; a lightweight regex scan at extraction flags suspect text and
  replaces it with a redacted marker in chat context, while the verbatim
  text remains accessible only via the bbox overlay viewer.
- **File upload.** Allowlist plus size cap, no deeper validation. A
  renamed binary will fail at the rendering step rather than the boundary.

### Observability and cost

- **LangSmith as the canonical store.** Every chat turn and every upload
  job is a trace; worker handoffs are child runs; provider calls
  (OpenRouter VLM, OpenRouter chat synthesis, Pinecone Inference embed,
  Pinecone Inference rerank, Pinecone vector queries) are wrapped as
  child runs with cost metadata.
- **Pinned per-model pricing table** in source for cost-tagging providers
  whose responses do not include cost. The cost report is generated by a
  script that reads from the LangSmith API.
- **No local metrics rollup table.** Trace tags discriminate `kind:chat`
  vs `kind:extract` and carry the eval run id when applicable.

### Eval gate

- **50-case composition.** 12 lab PDF extraction, 8 intake form
  extraction, 10 pure guideline retrieval, 6 multi-source synthesis, 5
  refusal and missing-data, 4 anti-hallucination, 5 PHI-leak. Wrong-patient
  and prompt-injection cases share slots within the existing buckets.
- **Five rubrics.** schema_valid, citation_present, factually_consistent,
  safe_refusal, no_phi_in_logs — all deterministic JavaScript assertions
  that run as promptfoo post-test checks. No LLM judge.
- **Thresholds.** schema_valid 95%, citation_present 95%,
  factually_consistent 100%, safe_refusal 90%, no_phi_in_logs 100%.
  Regression delta of −5 percentage points against a committed baseline
  for any rubric fails the build.
- **Frozen sidecar fixtures.** The 20 extraction-bucket cases run against
  pre-extracted JSON committed alongside fixture PDFs; the VLM is not
  re-invoked at eval time. A separate small ingest smoke suite exercises
  the live extraction pipeline end-to-end.
- **PR-blocking gate is a GitHub Action.** Local pre-push hook is a
  convenience layer for fast feedback, not the source of truth.
- **Baseline promotion via PR.** The committed `baseline.json` is updated
  only by an explicit pull request titled "promote eval baseline" — never
  auto-updated.

### Demo data

- **Six fixtures organized by failure mode** (3 lab PDFs, 3 intake forms),
  with one to two demo patients. Generator script for clean fixtures,
  hand-crafted bytes for the messy ones (partial scan, blank field,
  handwritten). Pre-extracted JSON for each fixture is committed and is
  the single source of truth for the deterministic eval suite.
- **Demo PDF patient seeder** runs after the existing Synthea seeder; uses
  a `pubpid` prefix so the existing reset path matches and cleans up
  demo patients without touching Synthea data.

### Deploy

- **Two Railway services.** Existing OpenEMR PHP service plus the agent
  Node service. The agent's bootstrap module waits on OpenEMR readiness,
  then runs guideline ingest and fixture ingest if env-gated. Both ingest
  steps are idempotent.
- **Env vars.** Documented in the README and a `.env.example`. The agent
  side adds the pinned VLM slug (`OPENROUTER_VLM_MODEL`), the Pinecone
  index/embed/rerank slugs (`PINECONE_INDEX_NAME`, `PINECONE_EMBED_MODEL`,
  `PINECONE_RERANK_MODEL`), the Pinecone API key, and the two ingest
  gates on top of the existing OpenRouter, JWT, LangSmith, and OpenEMR
  variables. Two providers total — OpenRouter and Pinecone. All model
  slugs live in env, not as literals in code.
- **Bootstrap failure isolation.** Bootstrap failures are logged but do
  not prevent server start. A cold-start agent without fixtures is still
  usable for clinicians who upload their own documents.

### MVP-vs-Final scope split

- **Tuesday milestone (vertical slice):** one upload-to-answer path through
  extraction and retrieval, single corpus source ingested, no supervisor
  graph yet, no eval suite yet, no deploy yet.
- **Thursday milestone (full MVP per spec's recommended steps):**
  supervisor graph, all four corpus sources, full extraction-pipeline
  quality layers, 50-case eval with PR-blocking GitHub Action, deployed
  Railway, bbox overlay viewer, real PHI redactor, demo video.
- **Sunday final:** polish, refined cost report, architecture-doc final
  pass, interview prep.

## Testing Decisions

A good test for this codebase exercises external behavior — a function's
input/output contract or a module's public surface — without binding to
implementation details. Tests that snapshot internal state or assert on
private helpers create churn whenever the implementation evolves; tests
that exercise the public interface stay stable across refactors and remain
useful evidence that the contract holds. The Week 1 promptfoo suite is the
prior art for this posture: every assertion is "either an exact tool-call
citation prefix or an exact keyword/regex" — no vibe checks. Week 2's
deterministic JavaScript rubric assertions extend that philosophy.

The deep modules in this PRD earn isolated test suites:

- **Schemas (lab and intake).** Validation tests proving valid payloads
  parse cleanly and invalid payloads throw with the right error path. Four
  to six positive and negative cases per schema. Prior art: existing Zod
  schemas under the agent service have round-trip parse tests.
- **Citation contract and verifier.** Tests proving that valid citations
  resolve through their respective lookup paths (sidecar row exists,
  Pinecone chunk fetched, tool transcript row present), that quoted spans
  for guideline citations must be substrings of the named chunk body, and
  that the verifier drops unverifiable claims rather than passing them
  through. The 100% factually_consistent floor in the eval suite depends
  on this behavior holding under unit test, not just under integration.
- **Document extraction reconciliation step.** Tests covering the
  patient-name match algorithm (token-set comparison with normalization)
  and the injection-pattern regex scan. Both are pure functions over
  strings and lists of strings, so they are cheap and fast to test
  exhaustively.
- **Hybrid retriever.** Tests proving that BM25 returns results for known
  queries against a fixture corpus, that RRF fusion correctly blends two
  ranked lists, and that the rerank step preserves expected order on
  fixtures with known correct ordering. Pinecone Inference clients are
  stubbed; the deep module's internal logic is what is under test.
- **PHI redactor.** Tests proving that a payload containing known PHI
  tokens (name, DOB, MRN, address, phone) returns a redacted payload
  with no PHI tokens remaining, and that structural fields pass through
  untouched. End-to-end coverage of the redactor is also asserted by the
  five PHI-leak eval cases, but the redactor itself is small and pure
  enough to deserve its own test surface.
- **Eval rubric assertions.** Tests proving that each of the five rubric
  functions returns the right boolean against fixture inputs covering
  both the pass and fail edges. The rubric assertions are themselves the
  thing the gate's correctness depends on, so they need a trustworthy
  test surface independent of the eval cases that exercise them.

The remaining modules — sidecar persistence and FHIR write-through, the
guideline-corpus ingest pipeline, the supervisor graph, the upload widget,
the bbox overlay viewer, the upload-jobs queue, the bootstrap module, and
the demo seeders — are tested through integration: the 50-case eval suite,
the ingest smoke suite, and a small set of HTTP-level integration tests
covering the upload endpoint and SSE flow. Adding unit tests for these
would test the implementation rather than the contract.

## Out of Scope

- A critic agent that rejects uncited claims or unsafe action suggestions.
  This is named in the spec's extension list and is not part of MVP.
- A third document type (e.g. referral fax, medication list) beyond lab
  PDF and intake form.
- A lab trend chart widget that consumes extracted Observation data.
- ColQwen2 multi-vector visual document indexing for retrieval.
- Domain-specific retrieval improvements beyond the chosen corpus,
  chunking, fusion, and reranker.
- Auto-classification of uploaded documents into doc types.
- A UI override path for wrong-patient hard blocks. (None exists, because
  there is no hard block in the chosen design — only a warning.)
- Backfilling extracted FHIR Observations from previously uploaded
  documents that pre-date this work.
- Multi-page document support beyond what the chosen rendering pipeline
  produces; per-page bbox is captured, but cross-page reasoning beyond
  schema-level structure is not built.
- An admin tool for manually overriding a wrong-patient mismatch is named
  but not implemented in this PRD; it is a future concern.

## Further Notes

This PRD is downstream of a 19-question design review whose decisions are
captured here. The intended companion artifact is `W2_ARCHITECTURE.md` at
the repository root, which walks the same system end-to-end with diagrams
and an explicit risks/trade-offs section for the architecture defense.

A few decisions deserve emphasis because they trade safety for scope and
will be the most likely topics of grader probing:

- **Wrong-patient detection is name-only with warning-only enforcement.**
  Two patients with colliding names will not trigger the warning; the
  document will fully ingest and write through to FHIR. This is a
  deliberate MVP scope cut.
- **Extraction is single-pass VLM with no OCR backstop.** The
  crop-and-verify second pass is the structural defense against
  hallucination; bbox accuracy depends on the VLM rather than OCR
  coordinates. The deep extraction module is built so the underlying VLM
  can be swapped if fixture accuracy demands it.
- **The verifier is fail-closed at 100% factually_consistent.** Claims
  with unverifiable citations are dropped from the response; if too many
  are dropped, the answer degrades to a low-confidence refusal. This
  shifts user-visible behavior toward refusal under uncertainty, which is
  correct posture for clinical use but visibly different from a more
  permissive Week 1.
- **All observability runs through LangSmith.** There is no parallel
  local metrics table; the cost report is generated from the LangSmith
  API. This depends on LangSmith availability for the cost-report
  deliverable but reduces operational surface.
