# Audit — OpenEMR Fork (Clinical Co-Pilot Foundation)

> AgentForge | Gauntlet AI Austin Admission, Week 1 | MVP gate (Tuesday)
> Companion to `ARCHITECTURE.md`. Read-only audit of the OpenEMR fork at `/home/lateridiot/gauntlet_ai/openemr`. Findings are scoped to what affects a Clinical Co-Pilot AI agent.

---

## Summary

OpenEMR is a real EHR — about fifteen years old, in production today, with good bones. Modern code lives under `src/` with PSR-4, Symfony, Twig, and strict static analysis; legacy procedural PHP is walled off in its own folders. The integration path for an AI agent is clean: a new namespace under `src`, an existing FHIR API for patient data, and an existing audit logger and JWT library to reuse. No fighting the codebase.

Five audits — security, performance, architecture, data quality, compliance. Headlines:

**Security.** The biggest finding is that OpenEMR's FHIR permissions are role-level, not patient-level — a clinician with `patients/read` can pull any chart by ID. That's also why the agent design uses a 120-second JWT bound to one patient: the token turns a coarse role check into a per-patient guarantee. Other findings — default DB credentials in the repo, unhardened session cookies, MFA with no rate limit — are real but fixable at deployment, not blockers for the agent.

**Performance.** Each chat turn issues 5–8 FHIR calls. Today those endpoints aren't tuned for that pattern: N+1 queries in `FhirObservationService`, four missing compound indexes, no default `_count` pagination. A long-history patient could produce a 50 MB bundle and multi-second latency. Fix: one small migration plus enabling OPcache. That gets us inside the latency budget.

**Architecture.** New code lives in one folder. The sidebar mounts via a Twig partial. The agent only talks to FHIR, never directly to the DB. Every action goes through the existing audit logger. The agent is additive — if it disappears, the EHR is unaffected.

**Data quality.** Clinical data is loosely typed. One table holds problems, allergies, and medications, separated by a free-text label. Drug names are text without standard codes. Dates are often nullable. The agent has to treat the data as authoritative *as-is*, surface gaps honestly, and never invent missing values.

**Compliance.** The audit logger is comprehensive but two important settings (`audit_events_query`, `enable_auditlog_encryption`) are off by default — both must be on. OpenAI and LangSmith BAAs are assumed for now and must be verified before any real patient data flows.

**Bottom line.** This fork is a defensible foundation. The agent architecture already addresses the most serious findings. What's left: configuration hardening, one DB migration, and a redaction layer for observability traces — all traceable to specific findings below, none speculative.

---

## 1. Security Audit

### Authentication & sessions

- **Default DB credentials in repo.** `sites/default/sqlconf.php` ships with `$login = 'openemr'` / `$pass = 'openemr'`. *Severity: High.* Production deployments must regenerate; fork-from-image deployments are at risk if defaults are not rotated. → Mitigation: deploy step regenerates `sqlconf.php`.
- **Session cookie flags not enforced in code.** `interface/globals.php` does not explicitly `ini_set('session.cookie_httponly', '1')` or `cookie_secure`. *Severity: Medium.* If `HttpOnly` is off, an XSS in a legacy `interface/` page can steal the session — that is the kind of compromise a clinical AI sidebar increases the blast radius of, not decreases. → Mitigation: enforce in deployment `php.ini`, isolate the agent UI in Shadow DOM (D6 of ARCHITECTURE.md), keep the agent service off the public ingress.
- **MFA brute-force.** `src/Common/Auth/MfaUtils.php` does not visibly rate-limit TOTP attempts after a successful password step. *Severity: Medium.* 6-digit TOTP without lockout is brute-forceable post-password.
- **2-hour default session timeout** (`interface/globals.php`, `library/auth.inc.php`). *Severity: Low–Medium.* Long-lived sessions widen the window in which a stolen cookie or unattended workstation matters.

### Authorization (ACL) & FHIR

- **FHIR ACL is role-level, not patient-level.** `src/RestControllers/Config/RestConfig.php:185` calls `AclMain::aclCheckCore($section, $value, $user, $aclPermission)` per endpoint, but the check resolves to "does this role have `patients/read`?", not "is this clinician assigned to this patient?". *Severity: High.* In practice, per-patient scoping must be layered on top — and that is exactly what the agent's per-turn JWT (D4, D5 in ARCHITECTURE.md) does. The implication is that **the JWT scope is load-bearing security, not redundant defence-in-depth**.
- **Patient ID flows from `$_GET`/`$_POST` into the session.** `interface/globals.php` writes `$_GET['pid']` into session state; the agent must never read patient ID from this path. → Mitigation: the agent's tool wrapper injects `pid` from the JWT, never from request bodies (D5).
- **CSRF not enforced on Bearer-authenticated REST.** `CsrfUtils::checkCsrfInput()` covers form posts; OAuth2 Bearer-token endpoints rely on the token alone. *Severity: Medium.* For an internal agent-to-OpenEMR call this is acceptable (same-origin SSE proxy + scoped JWT), but no third-party origin should be allowed to call `/apis/fhir/*` from the browser session.

### Data exposure

- **Stack traces leak in dev mode.** `src/Core/ErrorHandler.php` will append exception detail when `$shouldDisplayErrors` is true (driven by `OPENEMR__ENVIRONMENT=dev` or `user_debug` global). *Severity: Medium.* Production Dockerfile must pin `OPENEMR__ENVIRONMENT != dev`.
- **HTTP request audit logging may capture Authorization headers.** `EventAuditLogger::logHttpRequest()` is enabled by default. *Severity: Medium.* If an error is raised on a Bearer-authenticated request, the token can land in the audit table.
- **Patient demographics stored plaintext.** `CryptoGen` exists but column-level encryption is not applied to `patient_data.fname/lname/DOB/phone`. *Severity: Medium.* Backup hygiene is the mitigation; not the agent's problem to solve, but the agent's traces (Langfuse) must be redacted before egress (D12).

### Secrets & supply chain

- **OAuth2 keys auto-generated** (`src/Common/Auth/OAuth2KeyConfig.php`). *Info.* On first boot OpenEMR generates keys; rotation procedure must be documented in deployment runbook.
- **`league/oauth2-server` ^8.4** (composer.json). *Info.* Current major; track CVEs.

---

## 2. Performance Audit

The agent's tight path is 5–8 FHIR calls per chat turn against the patient's structured record. Findings are ranked by impact on that path.

### Database — missing compound indexes (High)

- **`lists(pid, type, activity)`** — `lists` carries problems, allergies, meds via `type`. Existing single-column `KEY pid` and `KEY type` (sql/database.sql) force scan + filter. Compound index turns "active allergies for patient X" into a seek.
- **`form_vitals(pid, date)`** — vitals queries are `WHERE pid = ? ORDER BY date DESC LIMIT N`. Existing `KEY pid` only.
- **`form_encounter(pid, date)`** — separate `KEY pid_encounter` and `KEY encounter_date`; no compound for "last N encounters for patient".
- **`prescriptions(patient_id, active, start_date)`** — same pattern; existing `KEY patient_id` only.

### FHIR controller hot spots (High)

- **N+1 sub-service fan-out in `FhirObservationService`.** `src/Services/FHIR/FhirObservationService.php` instantiates and sequentially queries 10 observation sub-services (vitals, labs, social-history, …) on every `Observation` search. Each sub-service hits the DB independently for the same patient. The agent's `get_recent_labs` and `get_vitals` both pass through this path. *Impact:* hundreds of ms per call, possibly seconds.
- **`MappedServiceTrait::getMappedServiceForResourceUuid`** linearly probes all sub-services to resolve a single UUID — worst-case 9 wasted queries per single-observation read.
- **No default `_count` pagination.** `FhirServiceBase` reads `_config` but no controller enforces a default page size; a chronic patient with 5 000 observations returns one giant bundle.

### Bootstrap & runtime (Medium)

- **OPcache disabled in `docker/development-easy*/php.ini`** (settings commented out). Re-parsing 500+ PHP files per request adds 50–200 ms; over 8 fan-out calls per chat turn that compounds to 1–2 s of avoidable latency.
- **Per-request service instantiation.** No DI singleton caching for FHIR sub-services; every request reconstructs the hierarchy.
- **No HTTP cache headers** on FHIR responses (no `ETag`, `Last-Modified`, `Cache-Control`). Patient demographics rarely change but are re-fetched every turn.

### Concurrency

- The dev image runs Apache `mod_php`. Worker count, `MaxRequestWorkers`, and MariaDB `max_connections` define the concurrent-user ceiling; a 500-bed deployment needs PHP-FPM, sized worker pools, and a read-replica strategy. *Implication for ARCHITECTURE.md scaling table:* the row at 1 000 users is where MariaDB read replicas become non-optional.

### Implication for the agent

- **Parallel tool fan-out on the Node side is mandatory.** Hitting the FHIR controllers serially cannot meet the "answer in seconds" bar even with the best-case schema.
- **One focused migration before live demo.** Add the four compound indexes above. They cost a few seconds to apply and remove the worst latency tax.
- **Tools should request narrow projections.** `get_vitals` does not need every column of `form_vitals`. Where the FHIR controller does not allow projection, the agent's tool wrapper should drop unused fields before they are sent into the model context — saving tokens and time.

---

## 3. Architecture Audit

The codebase has a clearly modern integration surface — agent code does not need to touch the legacy layer.

### Where things live

| Layer | Path | Use it for |
|---|---|---|
| Modern PSR-4 | `src/` (`OpenEMR\` namespace) | All new agent code |
| Service base | `src/Services/BaseService.php` | Pattern for any read/write service |
| FHIR REST | `src/RestControllers/FHIR/` (~40 controllers) | The agent's *only* data source |
| ACL | `src/Common/Acl/AclMain.php:166` (`aclCheckCore`) | Per-call authorisation gate |
| Audit | `src/Common/Logging/EventAuditLogger.php:196` (`newEvent`) | Single audit surface — do not invent a parallel one |
| JWT | `lcobucci/jwt ^4.3.0` (already a dependency) | Scoped 120s tokens, no new dep |
| Twig | `templates/`, `twig/twig ^3.22.2` | Sidebar partial, safe escaping (`|text`, `|attr`, `|xlt`) |
| Events | Symfony `EventDispatcher`, `src/Events/` | Future write-side hooks |
| DI | `config/services.php`, Firehed Container (PSR-11) | Wire agent services |
| Legacy — avoid | `library/`, `interface/`, Smarty 4.5 templates | Do not put new code here |

### Clinical data — table → FHIR resource

| Table | FHIR Resource | Used by tool |
|---|---|---|
| `patient_data` | `Patient` | `get_patient_summary` |
| `lists` (type=problem) | `Condition` | `get_active_problems` |
| `lists` (type=allergy) | `AllergyIntolerance` | `get_allergies` |
| `prescriptions` | `MedicationRequest` | `get_medications` |
| `form_vitals` | `Observation` (vital-signs) | `get_vitals` |
| `procedure_result` | `Observation` (laboratory) | `get_recent_labs` |
| `form_encounter` | `Encounter` | `get_recent_encounters` |

### Integration points

1. **Sidebar mount.** `interface/patient_file/encounter/encounter_top.php` — Twig partial includes the `<agent-sidebar>` Web Component (D6 in ARCHITECTURE.md).
2. **PHP entry points.** `src/AgentForge/` — `ChatController` (POST /interface/agentforge/chat), `ConversationController`, `JwtMinter`, `AuditService`. Modern routing through `public/index.php` and `src/BC/FallbackRouter.php`.
3. **Agent's outbound calls.** Always to `/apis/fhir/R4/*` with the scoped JWT as Bearer.
4. **Audit.** Every chat turn → `EventAuditLogger::newEvent('agentforge:chat:turn', …, $pid, …)`. No parallel audit table.
5. **Events (future).** `src/Events/AgentForge/` for `ChatInitiated`, `ChatCompleted` — listeners can plug in via `config/services.php`.

### Tech-debt zones to avoid

- `library/` — procedural helpers (`sqlQuery`, `sqlFetchArray`, …). Don't extend.
- `interface/` — UI templates with mixed PHP/HTML; only entry-point file we touch is `encounter_top.php`, and only to include a Twig partial.
- `$GLOBALS` / `$_SESSION` as service locator. Agent code uses constructor DI and the JWT — never reads session state for security decisions.

---

## 4. Data Quality Audit

Clinical concepts are loosely typed across the schema. These become **agent failure modes** unless the agent treats the data as authoritative *and surfaces gaps honestly*.

### Loose typing

- **`lists.type` is free-text (varchar(255), nullable)** — same table holds problems, allergies, medications, surgeries. No CHECK constraint, no FK to `list_options`. A typo (`'medicaton'`) silently drops rows from queries. *Agent failure mode:* `get_active_problems` returns an incomplete list and the agent confidently summarises it.
- **`prescriptions.drug` is varchar(150), `rxnorm_drugcode` is varchar(25) NULLABLE.** Same medication may appear as "Lisinopril", "lisinopril", "Lisinopril 10mg" with no RxNorm to normalise. *Agent failure mode:* the deterministic DDI check (Layer 2 of verification) degrades to text matching where RxNorm is missing — the agent must surface the degradation, not silently substitute.
- **`lists.diagnosis`, `prescriptions.diagnosis` — free-text, optional ICD-10 / SNOMED.** "HTN" vs "Hypertension" vs "High Blood Pressure" appear as three separate problems.
- **`form_observation.code`, `procedure_result.result_code`** — nullable, free-text, no LOINC enforcement. Lab results can land without a code.

### Activeness ambiguity

- **`prescriptions.active = 1` AND `end_date` in the past** is a legal state. *Agent failure mode:* "Currently taking …" for a drug stopped two years ago. Mitigation: the `get_medications` tool filters on both `active=1` AND (`end_date IS NULL OR end_date > NOW()`).
- **`lists.activity` is nullable tinyint** — `NULL` vs `0` vs `1` is undocumented. Tool wrappers must treat `NULL` as "active" or "unknown" deliberately, not by accident.

### Date hygiene

- **Most clinical date columns are nullable with no default** (`patient_data.date`, `prescriptions.start_date`, `lists.begdate`, `form_encounter.date`). NULL sorts last on MariaDB by default — "most recent" queries can silently include never-dated records. Tool wrappers must `ORDER BY date DESC` *with* `WHERE date IS NOT NULL`.

### Free-text dumping grounds

- **Encounter notes, chief complaint, HPI live in `pnotes` and free-text fields** with no structure. Out of scope for MVP per ARCHITECTURE.md (D10) — the agent says "I don't have summarised note content; open the chart" rather than guessing. **This is a feature**: surfacing the gap is the right behaviour.

### Identifier optionality

- **`patient_data.sex` is varchar(255) default ''** — "M", "Male", "M ", "" all coexist. Treat as untrusted; never use for clinical decisioning without normalisation.
- **Foreign-key relationships are largely advisory** (no FK constraints on `lists.pid → patient_data.pid`). An orphan row will not be caught by the DB.

### Implication for the agent

- The verifier (Layer 1, citation grounding) checks claims against tool-result rows — it does **not** validate that the underlying data is internally consistent. That is by design and per the project requirements ("the agent must not state something the data doesn't say"; it can still report stale or contradictory data, *as long as it cites it*).
- The clinical-rule engine (Layer 2) is the place that catches contradictions worth flagging (allergy vs medication, drug-drug interactions). Anything subtler — "this BMI is implausible" — is out of scope for MVP.
- Where data is missing, the agent must say so. A "no recent labs in the last 90 days" answer is correct; a fabricated lab value is the failure mode.

---

## 5. Compliance & Regulatory Audit

### Audit logging — 45 CFR §164.312(b)

- **Comprehensive logger exists.** `EventAuditLogger` writes to `log` (and `audit_master`/`audit_details`) with user, group, patient, event, success. Every PHI write is logged.
- **SELECT logging is OFF by default.** `EventAuditLogger::auditSQLEvent()` skips SELECTs unless `audit_events_query` is set. **Action:** turn it on for any deployment that runs the agent (the agent is a heavy reader).
- **Comment encryption is OFF by default.** `enable_auditlog_encryption` toggles encryption of the `comments` field via `Crypto`. **Action:** turn it on; agent tool URLs and parameters land in the comment field.
- **Checksums are hash digests, not HMAC-signed.** A privileged DBA can rewrite the log without cryptographic detection. **Mitigation:** export logs to an immutable third-party (syslog over TLS, CloudTrail, SIEM).
- **Agent accountability.** Agent calls inherit the user identity from the scoped JWT. The audit log shows the clinician's username — not "the agent". The agent's `event` strings (`agentforge:chat:turn`, `agentforge:tool:call`) are how a compliance officer reconstructs which actions were AI-mediated.

### Data retention

- **No automated retention enforcement** in OpenEMR. Soft-delete patterns (`deleted` flag, `activity` flag) exist; record purge is administrative. HIPAA does not mandate a retention floor; state law does (TX/CA typically 7 years).
- **Agent state retention.** Per ARCHITECTURE.md D11, conversation rows in Postgres are TTL'd 30 minutes after last activity; only de-identified metrics persist long-term. This is *more aggressive* than OpenEMR's posture by design.

### Breach notification — 45 CFR §164.400

- **No anomaly detection ships in the codebase.** No mass-export alerts, no rate limiting on bulk FHIR queries. Mitigation lives at the deployment layer (SIEM rules, Railway/Cloud egress alerts).
- **Agent does not introduce new breach surface.** Tool calls are scoped to one patient per turn (D5). The structural cap on blast radius matters more than detection.

### BAA implications — 45 CFR §164.504(e)

- **OpenAI BAA assumed per project framing.** PHI flows to OpenAI in tool results (the model needs the actual lab value). Production deployment requires the BAA to actually be in place and OpenAI training opt-out confirmed.
- **Langfuse BAA-eligible** but the redaction layer that strips Safe Harbor identifiers from spans before egress is *planned* (D12) and **not yet implemented in code**. Either implement it or self-host Langfuse on Railway before any non-demo data flows.
- **Railway does not currently sign BAAs.** Acceptable for demo data; production deployment moves to a BAA-signing host (AWS/GCP/Azure) using the same architecture (D14). The architectural shape is portable; only the hosting decision changes.

### Minimum-necessary — 45 CFR §164.502(b)

- **FHIR ACL is role-level, not patient-level.** A clinician with global `patients/read` can read any chart. Per-patient scoping for the agent comes from the JWT (D5), not from OpenEMR — this is the load-bearing finding from the security audit, repeated here under its compliance lens.
- **Agent tools are deliberately narrow.** Structured FHIR resources only; no notes RAG, no attachment access. This is a minimum-necessary-aligned scope by construction.

### Patient rights — 45 CFR §§164.524, 164.526, 164.528

- **Accounting of disclosures.** OpenEMR's `extended_log` table supports this via `EventAuditLogger::recordDisclosure()`. Agent-driven accesses appear in the standard audit log under the clinician's identity, with the `agentforge:*` event strings indicating AI-mediation. A patient request "show me everywhere my record was accessed" is answerable.
- **Right to amend.** `amendments` / `amendments_history` tables exist; agent is read-only for MVP and does not interact with this surface.

### Technical safeguards — 45 CFR §164.312

| Safeguard | Status | Note |
|---|---|---|
| Access control (a)(2)(i) | ✓ | AclMain + JWT patient-scope |
| Audit controls (b) | ✓ if configured | `audit_events_query` and encryption must be on |
| Integrity (c)(2) | △ | Hash-only checksums; export to immutable store |
| Transmission security (e)(2) | ✓ | HTTPS public; private VPC internal — **confirm internal TLS** |
| Encryption at rest | △ | Demographics plaintext; backup hygiene matters |

### State / federal-specialty

- **42 CFR Part 2 (substance-use records)** — OpenEMR ships no Part 2 marking. If the deployment has substance-abuse programs, those records must be marked and the agent must be excluded from them at the ACL layer.

### Pre-deployment checklist

1. Verify OpenAI BAA (production only).
2. Implement PHI redaction in agent observability before non-demo data flows.
3. Set `enable_auditlog_encryption = 1`.
4. Set `audit_events_query = 1`.
5. Rotate `sites/default/sqlconf.php` credentials.
6. Confirm `OPENEMR__ENVIRONMENT != 'dev'` in production image.
7. Configure clinician roles to scope `patients/read` to assigned panels (where the deployment requires it).
8. Add the four compound indexes from §2 before live load.
9. Export OpenEMR audit logs to an immutable SIEM.
10. If applicable: Part 2 marking & ACL exclusions.

---

## What This Audit Changes in the Agent Plan

The audit confirms most of `ARCHITECTURE.md` and sharpens three things:

1. **The JWT patient-scope (D5) is not redundant.** Because OpenEMR's FHIR ACL is role-level rather than per-patient, the JWT-bound `patient_uuid` is the layer that delivers per-patient guarantees. This becomes the headline answer to "where are the trust boundaries and how are they enforced?"
2. **Tool wrappers must defend against data-quality cliffs explicitly.** `get_medications` filters by both `active=1` AND `end_date` semantics. `get_active_problems` treats `lists.activity IS NULL` as the deliberate convention the data uses. Where RxNorm is missing, the DDI check declares a degraded-mode result rather than silently substituting text matching.
3. **Pre-demo work is small but specific.** Four compound indexes; OPcache on; `_count` defaults; `audit_events_query` and `enable_auditlog_encryption` on. None of these are speculative hardening — each one is traceable to a finding above.
