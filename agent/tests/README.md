# AgentForge Test Suite — Run Book

## Status (Red Phase)

This is the TDD red phase. **All tests are expected to fail today.** They fail because
production code does not exist yet. That is the point — the tests specify the contracts
the implementing engineer must satisfy.

---

## How to Run Each Suite

### PHP isolated tests (no Docker, no DB)

From the OpenEMR repo root:

```bash
composer phpunit-isolated -- --filter AgentForge
```

Expected today: **FAIL** — `ScopedJwtMinter`, `ChatRequest`, `AgentAuditService` classes
do not exist in `src/AgentForge/` yet.

### PHP unit tests (requires Docker + OpenEMR container)

From `docker/development-easy/`:

```bash
docker compose exec openemr /root/devtools unit-test
```

Or filtered:

```bash
docker compose exec openemr vendor/bin/phpunit tests/Tests/Unit/AgentForge/ --testdox
```

Expected today: **FAIL** — same reason (no production classes).

### Node / TypeScript unit tests

From `agent/`:

```bash
pnpm install   # first time only
pnpm test:unit
```

Expected today: **FAIL** — every import in `tests/unit/**/*.test.ts` references a module
under `src/` that does not exist yet. Errors will be of the form:
```
Cannot find module '../../../src/middleware/verifyJwt.js'
```

### Node / TypeScript integration tests

From `agent/`:

```bash
pnpm test:integration
```

Expected today: **FAIL** with `.todo` — integration tests are pending until `buildServer()`
is exported (M2 milestone).

### Web Component tests

From `agent/`:

```bash
pnpm test --config tests/web-component/vitest.config.ts
```

Expected today: **FAIL** with `.todo` — component not built yet. The shadow DOM sanity
checks (non-todo) pass immediately.

### Promptfoo eval suite

From `agent/`:

```bash
EVAL_JWT=<synthetic-jwt> pnpm eval
```

Expected today: **FAIL** — requires a running agent service on `localhost:3000` and
an MSW FHIR mock harness. This suite is runnable after M3.

---

## Milestone → Tests Turn Green

| Milestone | Tests that turn green |
|---|---|
| M1 (PHP host module) | `ScopedJwtMinterIsolatedTest`, `ChatRequestIsolatedTest`, `AgentAuditServiceTest`, `ScopedJwtClaimsTest`, `AgentSidebarPartialRenderTest` |
| M2 (Node skeleton) | `verifyJwt.test.ts`, `FhirClient.test.ts`, `router.test.ts`, `/healthz` integration |
| M3 (LLM + tools) | All 8 tool tests, `AnswerSchema.test.ts`, `ConversationRepository.test.ts`, `/chat` integration |
| M4 (Verification) | `verifyLayer1.test.ts`, `ClinicalRuleEngine.test.ts`, `judge.test.ts` |
| M5 (Observability) | `PhiRedactor.test.ts` |
| M6 (Eval framework) | All 8 Promptfoo fixture classes |
| M7 (Hardening) | Rate limit tests in `ConversationRepository.test.ts` |

---

## Deferred Tests (markTestIncomplete / it.todo)

| Test | Reason | Plan reference |
|---|---|---|
| `SseProxyHandlerTest::proxyUsesJwtAsBearerToken` | Needs injectable PSR-18 HTTP client | §3.1 |
| `ChatControllerTest::handleEmitsAuditEvent` | Needs session-aware request mock | §3.1 |
| All `/chat` route integration tests | `buildServer()` not yet exported (M2) | §5.3 |
| All `/healthz` integration tests | Same | M2 |
| `PhiRedactor` PHI TTL purge tests | Needs injectable purge function (M3/M5) | §3.6 |
| All web component tests | Component not built (M1) | §5.2 |
| `AgentSidebarPartialRenderTest` | Template directory not created yet; Q-NEW-2 (Twig in encounter_top.php) | Q-NEW-2, M1 |

---

## Open Questions Affecting Tests

| Q# | Question | Affected tests |
|---|---|---|
| Q-NEW-2 | Is there a Twig env in encounter_top.php? | `AgentSidebarPartialRenderTest` (skipped until resolved) |
| Q-NEW-5 | lcobucci/clock v2 vs v3 (ClockInterface impl) | `ScopedJwtMinterIsolatedTest` uses a manual ClockInterface mock — works on both versions |
| Q1 | Langfuse BAA | `PhiRedactor.test.ts` (PHI-in-trace assertions depend on Langfuse being active) |
