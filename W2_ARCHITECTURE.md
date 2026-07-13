# AgentForge Clinical Co-Pilot — Week 2 Architecture

Companion to [`W2_PRD.md`](./prd/W2_PRD.md) and
[`W2_DOCUMENT_INBOX_PRD.md`](./prd/W2_DOCUMENT_INBOX_PRD.md). The PRDs
own intent; this doc captures the system **as built** so it stays
useful when the diff drifts ahead of the PRD.

---

## 1. Summary

Three capabilities on top of the Week-1 OpenEMR fork:

1. **Document Inbox.** Patient-level inbox owns lab-PDF and intake-form
   ingest end-to-end. Upload → extract → review → confirm. **Only on
   confirm** do values land on the chart (FHIR Observations for labs,
   `lists`/`pnotes` rows for intake). Re-uploading the same lab updates
   the chart row instead of duplicating it.
2. **Supervisor + grounded chat.** A LangGraph supervisor routes
   between three workers (intake, evidence retriever, clinical-data),
   then synthesizes through a fail-closed verifier. Every claim
   carries a machine-readable citation.
3. **Patient dashboard SPA** (W2 additional requirements — port the
   PHP-rendered OpenEMR patient dashboard to a modern framework
   without touching the backend). React over OpenEMR's existing REST
   and FHIR APIs, OAuth2/OIDC login, feature parity with the legacy
   PHP surface (patient header, allergies, problem list, medications,
   prescriptions, care team, plus one extra section). The dashboard's
   own design rationale and framework-choice defense live in
   [`PATIENT_DASHBOARD_MIGRATION.md`](./PATIENT_DASHBOARD_MIGRATION.md);
   this doc covers it only at the touch points (the React SPA shares
   the same OAuth2/OIDC issuer the agent uses, and renders inside the
   same OpenEMR shell that hosts the Document Inbox).

A deterministic-rubric promptfoo suite gates merges. Observability runs
through Langfuse with a no-escape-hatch PHI redactor.

---

## 2. Technology stack

| Layer | Tools |
|---|---|
| **Agent service** | Node 22+, TypeScript 5.7 (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), Fastify 5, LangGraph.js, LangChain.js (`@langchain/openai`), Zod, mupdf, sharp, jose |
| **LLM / VLM / OCR** | OpenRouter (Claude Haiku 4.5 chat, Sonnet 4.5 VLM, Gemini Flash bbox-selector option), Google Cloud Vision (`DOCUMENT_TEXT_DETECTION`) |
| **Retrieval** | Pinecone (`agentforge-guidelines-v1` index), Pinecone Inference embed `llama-text-embed-v2`, rerank `bge-reranker-v2-m3`; Cohere SDK for fallback rerank |
| **Observability** | Langfuse (per-turn trace, worker handoffs as child runs, provider calls cost-tagged); custom `PhiRedactor` + `PhiSetBuilder` wrapping the client with no runtime opt-out |
| **OpenEMR / PHP host** | PHP 8.2+ (PSR-4, PHPStan level 10), OpenEMR fork (FHIR R4 services, `documents`/`lists`/`pnotes`/`procedure_*` tables), Doctrine DBAL 4, Twig 3 (modern), Smarty 4.5 (legacy) |
| **Frontend** | React (W2 patient dashboard SPA over OpenEMR REST/FHIR), PDF.js 4.0.379 (`useSystemFonts:false` for parity with mupdf), Bootstrap 4.6 + jQuery 3.7 (W1 carryover), SASS + Gulp 4 |
| **Auth** | OAuth2 SMART backend-services (RS384 client_assertion); HS256 inter-service JWT (PHP ↔ agent); OIDC for the dashboard SPA |
| **Standards** | FHIR R4, LOINC (labs), RxNorm (meds), ICD-10 (problems), SNOMED CT |
| **Database** | MariaDB 11.8 dev / MySQL prod; idempotent migration runner at `contrib/agentforge/run_migrations.php` with drift reconciliation |
| **Testing** | Vitest 2.1 + msw 2.7 (Node, ~560 tests), PHPUnit 11 (PHP, isolated + DB suites), promptfoo (gated eval suite, deterministic JS rubrics, no LLM judge) |
| **Infra / deploy** | Docker multi-stage Alpine, Docker Compose for the dev stack, Railway for agent prod (IPv6 dual-stack bind), Apache for the PHP tier |
| **CI** | GitLab CI (`labs.gauntletai.com`) — `agent-test` + `agent-eval` gated to MRs into `master`; runs in fixture mode so no live OpenEMR/MariaDB. GitHub Actions mirror at `.github/workflows/agentforge-eval.yml`. `eval-gate.mjs` enforces `agent/evals/baseline.json` thresholds |
| **Dev tooling** | Rector, PHP_CodeSniffer, ESLint, Stylelint, codespell, prek pre-commit, conventional-commits CI check |

All LLM, embed, and rerank model slugs are pinned env vars
(`OPENROUTER_VLM_MODEL`, `OPENROUTER_BBOX_SELECTOR_MODEL`,
`PINECONE_EMBED_MODEL`, `PINECONE_RERANK_MODEL`) — never `latest`.

---

## 3. End-to-end flow

### 3.1 Upload → extraction → review → commit

```
Clinician                     POST /interface/agentforge/upload.php
  drop file + pick doc_type → UploadController                    (PHP)
                                │  validate MIME + size
                                │  Document::createDocument()       → documents
                                │  insert agentforge_upload_jobs    (status=pending,
                                │                                   file_hash_sha256)
                                │  ExtractionDispatcher → POST /extract (HS256 JWT)
                                ▼
                              Agent /extract                         (Node)
                                │  PageRenderer        → PNG per page (mupdf @ 3.0×, EXIF baked,
                                │                       trim-undo offsets recorded)
                                │  Google Vision OCR  ─┐
                                │  VLM extraction     ─┤ in parallel; VLM emits text only
                                │                      │ (no pixel coords)
                                │  LlmBboxSelector    ─┘ maps each entity → OCR line indices
                                │  BboxLocator         → unions selected line bboxes;
                                │                       falls back to token overlap on miss
                                │  Zod parse           → LabPdfSchema | IntakeFormSchema
                                ▼
                              Sidecar updated; status=ready_for_review (no chart write)
                                ▼
  ┌───────────  Review screen  ──────────────────────────────────────┐
  │  PdfPageViewer | ImageViewer + BboxOverlay + ReviewPanel         │
  │  edit values, per-row reject (labs), whole-doc reject            │
  └───────────────────────────┬──────────────────────────────────────┘
                              │  Confirm
                              ▼
                              ConfirmCommitter                       (PHP)
                                │  guards: status === ready_for_review (else 409)
                                │  EditedFieldPathDiffer  → JSON-path list of human edits
                                │  routes by doc_type:
                                │    lab_pdf     → LabFhirWriter     (idempotent)
                                │    intake_form → IntakeWriter      (idempotent per bucket)
                                │  appends agentforge_chart_evidence row per chart write
                                │  status=committed
```

**Idempotent chart writes.** Each writer computes a natural dedup key
and looks it up in `agentforge_chart_evidence` before inserting:

| Doc type    | Dedup key                                              |
|-------------|--------------------------------------------------------|
| Lab row     | `(patient, lower(LOINC) ‖ normalized(test_name), date)` |
| Medication  | `(patient, lower(name))`                               |
| Allergy     | `(patient, lower(substance))`                          |
| Chief concern | append-only — every commit is a moment in time      |

A hit UPDATEs the existing chart row and appends fresh evidence. A
miss INSERTs and appends evidence. Re-uploading a lab PDF therefore
refreshes a row's value/units/abnormal-flag rather than creating a
parallel row, and the inbox UI surfaces an `inserted=N, updated=M`
receipt. `agentforge_upload_jobs.file_hash_sha256` powers an
upload-time soft duplicate banner (no hard block — clinicians may have
a legitimate re-issue).

### 3.2 Chat

```
question → /chat                    (Node)
              │
              │  classifyOutOfScope → refusal? → short-circuit answer
              ▼
            Supervisor (LangGraph)
              │
              ├──→ IntakeExtractorWorker  (sidecar lookup by pid + doc_type)
              ├──→ EvidenceRetrieverWorker (BM25 ⊕ Pinecone → RRF → rerank)
              └──→ ClinicalDataWorker     (W1 graph: router → planner → tools)
              │
              ▼
            Synthesizer
              ▼
            Verifier (fail-closed)
              │  drops claims with unresolvable citations
              │  guideline `quote_or_value` must be a substring of the named chunk
              │  >50% drops → low-confidence refusal
              ▼
            AnswerSchema (every claim ≥1 citation)
```

Loop cap: six handoffs before forced synthesis. Each handoff is a
Langfuse child trace.

The deterministic refusal router fires before any FHIR call or
retrieval, covering five classes: `wrong_patient`, `order_entry`,
`multi_patient`, `general_knowledge`, `off_corpus_authority`. Pure
regex — no LLM call — so it cannot itself hallucinate a refusal.

---

## 4. Components

**PHP side (`src/AgentForge/`).** Boundary controllers
(`UploadController`, `DocumentInboxController`, `ConfirmJobController`,
`RejectJobController`, `JobStatusController`); the `UploadJobStatus`
state machine in `Domain/`; persistence (`SidecarPersister`,
`UploadJobsPersister`, `LabFhirWriter` + `LabFhirAdapter`,
`IntakeWriter` + `IntakeWriteAdapter`, `ConfirmCommitter`);
`ScopedJwtMinter` for the agent JWT. Adapters carry the dedup-key
logic; writers wire concrete SQL closures so the adapters stay
testable without a DB.

**Agent service (`agent/src/`).** `routes/extract.ts` and
`routes/chat.ts` are the HTTP entries. Extraction lives under
`extraction/` (`PageRenderer`, `GoogleVisionOcrService`, `VlmExtractor`,
`LlmBboxSelector`, `BboxLocator`, `ExtractionPipeline`). Schemas under
`schemas/` (Zod, `schema_version` literal on every payload). The
supervisor + workers are under `graph/supervisor/`; the W1 graph it
wraps is under `graph/`. Hybrid retrieval is under `retrieval/`. The
PHI redactor (no runtime opt-out) is under `observability/`. The
fixture-mode dispatcher used by the eval suite is under `eval/`.

**Frontend (`public/assets/agentforge/`).** `document-viewer.js` —
PDF.js (`useSystemFonts:false` for parity with the agent's mupdf
renderer), native `<img>` for image uploads, common surface for
`BboxOverlay`. `agent-sidebar.js` is the chat sidebar (W1 carryover).

---

## 5. Schemas

All Zod, all carry a literal `schema_version` field for forward
compatibility. The bbox shape is `{ page, x, y, w, h, image_w, image_h }`
in image-pixel space; `image_w` / `image_h` are the rendered PNG's
post-trim, post-EXIF dimensions, and `BboxOverlay` scales by
`canvasWidth / image_w` so any server-side downscale stays correct.

- **`VlmLabPdfSchema` / `VlmIntakeFormSchema`** — what the VLM is asked
  to return: text and structure only, **no bbox fields**. The locator
  fills bboxes from OCR.
- **`LabPdfSchema` / `IntakeFormSchema`** — final stored shape after
  `BboxLocator` runs: same data plus pixel-accurate bboxes per entity.
- **`BboxPlanSchema`** — the LLM bbox-selector's output: per-entity OCR
  line indices (and, for tight entities, word indices).
- **Citation contract** (discriminated union by `source_type`):
  `patient_document` (doc id + field path + bbox + citation_confidence),
  `guideline` (Pinecone chunk id + section id + `quote_or_value` +
  rerank score), `patient_record` (W1 `tool:<name>:row-<n>`).

---

## 6. Storage

| Table | Owner | Purpose |
|---|---|---|
| `documents`, `lists`, `pnotes` | OpenEMR core | Source bytes, intake meds/allergies, chief concern |
| `procedure_order` / `_report` / `_result` | OpenEMR core | Lab values written on confirm |
| `agentforge_document_extractions` | AgentForge | Sidecar — extracted JSON, schema version, status, reviewer columns |
| `agentforge_upload_jobs` | AgentForge | Upload-job state machine + `file_hash_sha256` for soft duplicate detection |
| `agentforge_resource_links` | AgentForge | Back-pointer: extraction → chart resource (legacy provenance trail) |
| `agentforge_chart_evidence` | AgentForge | Append-only audit trail keyed on the dedup tuple; drives idempotent UPDATE-vs-INSERT decisions on re-upload |

**Doc-type routing.** Doc type travels as an explicit form field, not
a category-name match.

**Deferred-commit gate.** The state machine throws on any commit
attempt outside `ready_for_review`, so a double-click cannot create
duplicate writes.

**Migrations.** `contrib/agentforge/run_migrations.php` is a custom
idempotent runner with a column-level drift reconciliation pass. Two
versions today: the W2 consolidation (`20260507150000`) and the
chart-evidence + file-hash addition (`20260510120000`). New columns
on managed tables go into BOTH the apply block and the
`$expectedColumns` map so existing Railway DBs catch up via drift
reconciliation.

---

## 7. Hybrid retrieval

Single corpus: ADA Standards of Care in Diabetes — 2026, structurally
chunked, indexed in Pinecone (`agentforge-guidelines-v1`).

```
query → BM25 (in-process, same chunk set) ─┐
        Pinecone Inference dense embed   ──┴── RRF → Pinecone rerank → top-5
```

All model slugs are pinned env vars (`PINECONE_EMBED_MODEL`,
`PINECONE_RERANK_MODEL`, `OPENROUTER_VLM_MODEL`) — never `latest`.

---

## 8. Observability and PHI redaction

Langfuse is the canonical trace store. Each chat turn and each upload
job is a top-level trace; worker handoffs and provider calls
(OpenRouter, Pinecone, Google Vision) are child runs.

The PHI redactor wraps the Langfuse client at construction time. There
is **no runtime opt-out**. Per request: `PhiSetBuilder` loads the
JWT-bound patient's PHI set from FHIR; field walks replace each PHI
substring with a stable HMAC token (over `(value, salt)`); structural
fields (tool names, latencies, citation ids, scores) pass through
untouched. Tokens are stable so traces remain joinable across spans.

PHI policy assumes a signed BAA with the trace provider (Langfuse Cloud,
HIPAA tier). If the BAA assumption changes, re-enable app-layer
redaction of trace payloads — see the codified test in
`tests/unit/observability/tracedClient.test.ts`.

---

## 9. Eval gate

Five deterministic JS rubrics (no LLM judge) with absolute floors and
regression deltas in `agent/evals/baseline.json`:
`schema_valid` 95%, `citation_present` 95%, `factually_consistent`
100%, `safe_refusal` 90%, `no_phi_in_logs` 100%. Baseline updates
require a PR titled exactly `promote eval baseline`.

The promptfoo suite runs in **fixture mode** in CI: at agent boot,
`AGENTFORGE_EVAL_FIXTURE_PATH` swaps `TOOL_REGISTRY` chart tools with
canned `ToolResult`s read from a JSON snapshot. CI does not need a
live OpenEMR or MariaDB. Refresh the snapshot with
`npm run eval:snapshot --pid=<n> --patient-uuid=<uuid>`. A loud
`EVAL FIXTURE MODE ACTIVE` warning at boot is the fail-fast signal —
production environments crash loudly if the env var ever leaks in.

---

## 10. Deployment

Two Railway services: OpenEMR (PHP) and the agent (Node). Boot order
on a fresh environment:

1. OpenEMR migrations (`auto_configure.php`).
2. AgentForge schema migrations
   (`contrib/agentforge/run_migrations.php` — manual run on Railway).
3. Synthea seeder (`pubpid LIKE 'AGENTFORGE-%'`).
4. Demo PDF patient seeder
   (`contrib/agentforge/seed_demo_pdf_patients.php`,
   `--clear-all-patients` for a clean reseed).
5. Agent service start. Bootstrap polls OpenEMR with backoff,
   conditionally ingests guidelines / fixtures (gated by env);
   bootstrap failures are logged but do **not** block server start.

Two providers in the data plane: OpenRouter (LLMs) and Pinecone
(retrieval). Plus Google Cloud Vision for OCR. All slugs and keys are
env vars — see `agent/.env.example` for the complete list.

Production never sets `AGENTFORGE_EVAL_FIXTURE_PATH`. The fixture
JSON isn't even copied into the production Docker image — the boot
guard would fail loudly if it tried to load.

---

## 11. Risks and trade-offs

**Extraction accuracy depends on three providers in series** (Google
Vision OCR → VLM → LLM bbox-selector). Any of them being wrong about
a row leads to a wrong row on the chart. The structural defense is
the **deferred-commit gate**: lab values do not appear on the chart
until a clinician has reviewed the side-by-side overlay and clicked
Confirm. Weak point: a clinician who clicks through without reading
still commits whatever the pipeline produced — the gate is
human-in-the-loop, not enforcing. Falling back to mechanical
token-overlap when the LLM bbox-selector errors is the in-pipeline
backstop.

**Single corpus source.** ADA Standards of Care 2026 is the only
guideline corpus. The parent PRD planned four sources. For
non-diabetes guideline questions the agent now refuses explicitly via
the `off_corpus_authority` refusal class (covers ACC/AHA, USPSTF,
AAFP, NICE, JNC, KDIGO, generic specialty-society catch-all) rather
than silently substituting ADA — that substitution was the most
concerning failure mode caught by the eval suite. Trade-off: the demo
narrative is narrowed to diabetes; safety posture is preserved by
explicit refusal.

**Wrong-patient detection is procedural, not structural.** The
sidecar's `patient_match_status` column always writes `unverifiable`.
A document uploaded to the wrong chart will extract, surface in the
review screen, and — if the reviewer doesn't catch the mismatch —
round-trip on Confirm. The deferred-commit review screen and the
deterministic refusal router (which catches mid-conversation Title-Case
patient mentions on the chat path) raise the chance of catching
errors but do not enforce a match.

**Injection scan deferred.** The sidecar's `injection_suspected`
column always writes `0`. The verifier's fail-closed substring check
on guideline citations and the supervisor's structural prompt
separation between document content and instructions are the only
in-pipeline defenses against carefully crafted document text.

**Idempotent chart writes use natural keys, not byte-hash.** Re-uploading
the same lab UPDATEs the chart row — value/units/abnormal-flag refresh
to the latest commit. The full history of every assertion (which
extraction, which document, when, by whom) lives in
`agentforge_chart_evidence`, but the chart row itself only carries
the latest. Trade-off: clinicians see one row per logical observation
(no duplicates polluting trends) at the cost of needing the evidence
table to reconstruct what changed across re-uploads. A re-issued lab
that corrects a value behaves correctly; an in-place edit affordance
on already-committed values is deferred (re-upload is the workflow).

**Langfuse is a single point of failure for observability.** No
parallel local metrics rollup; if Langfuse is down, traces are lost.
PHI policy assumes a signed Langfuse Cloud BAA. If the BAA assumption
ever changes, re-enable app-layer redaction of trace payloads (the
test in `tests/unit/observability/tracedClient.test.ts` codifies the
current "trust the BAA" stance).

**Eval composition is chat-side comprehensive, extraction-side
deferred.** 87 promptfoo cases cover use-case 1–7, multi-turn
conversations, evidence retrieval, anti-hallucination, and
out-of-corpus refusal — exhaustive on the chat surface. The
extraction-side rubric (lab/intake fixture PDFs through `/extract`)
is not yet a promptfoo provider; intake round-trip is covered by the
PHP HTTP-level integration test asserting that committed extractions
appear as queryable rows in `lists`/`pnotes`. Reintroducing a
deliberate regression in any covered behavior (refusal, PHI
redaction, schema validity, citation shape) still trips the gate;
extraction-side regressions might slip through to manual review.

**Workflow step the parent PRD did not require.** The deferred-commit
gate is a real workflow step — clinicians must open the review screen
and click Confirm. The parent PRD scoped extraction as
fire-and-forget. Trade-off: the demo video must show the
review-and-confirm step, or the safety value of the design is
invisible.
