# Testing Guide

Three flavours of tests live in this package, each with a different cost/scope
profile:

| Suite | Runtime | LLM hit? | Network? | Where |
|---|---|---|---|---|
| **Unit** | seconds | no | no | `tests/unit/**/*.test.ts` |
| **Integration** | seconds | no (stubbed planner) | in-process Fastify only | `tests/integration/**/*.test.ts` |
| **Offline evals** | seconds | no (recorded fixtures) | no | `tests/pipeline/**/*.test.ts` |
| **LLM evals (promptfoo)** | minutes, costs $ | **yes** | yes — agent on `:3030` + real FHIR | `evals/` |

Run them in order. Don't try to debug a failing promptfoo run with broken
unit tests — the eval suite assumes the lower layers are green.

## Unit tests

```bash
cd agent
npm run test:unit
```

Covers, by directory:

- `tests/unit/middleware/` — `verifyJwt` happy-path, expired, wrong audience,
  wrong scope.
- `tests/unit/fhir/` — `FhirClient` HTTP shape, `OpenEmrTokenProvider` token
  lifecycle (cache, expiry, RS384 `client_assertion` shape).
- `tests/unit/tools/` — each of the 8 tools: empty results, FHIR 4xx, citation
  ID format, `check_drug_interactions` degraded path.
- `tests/unit/graph/` — `runFollowup` and `runPrevisit` against in-memory
  fixtures, refusal-router behaviour, retry loop ceiling.
- `tests/unit/verification/` — Layer 1 citation grounding, `ClinicalRuleEngine`
  (DDI / allergy / dose), judge prompt parsing.
- `tests/unit/db/` — in-memory `ConversationRepository`, cache TTL,
  rate-limit counters.
- `tests/unit/observability/` — `PhiRedactor` patterns.
- `tests/unit/schemas/` — `AnswerSchema` Zod validation.

Vitest config: `vitest.config.ts` (Node env, 20 s timeout, `forks` pool).

## Integration tests

```bash
npm run test:integration
```

These boot Fastify in-process via `buildServer()` (exported from
`src/server.ts`) and exercise full routes:

- `POST /chat` with a valid JWT → structured `AnswerSchema` response.
- `POST /chat` with `STUB_PLANNER=true` → deterministic, no LLM.
- `GET /conversation/:id` round-trip.
- `GET /healthz` unauthenticated → 200.
- 401 paths: expired JWT, missing JWT, wrong `aud`, wrong `scope`.

FHIR is stubbed with `msw` (Mock Service Worker — see `package.json` devDeps),
so these tests do not need the OpenEMR container running.

## Offline evals (`tests/pipeline/`)

Vitest tests that exercise the deterministic clinical layer
(`BaselineHighlights`, `EncounterDiff`, `runPrevisit`, `runFollowup`) against
checked-in FHIR fixture bundles. They run in the same `vitest run` invocation
as everything else and **never make a network call or hit an LLM**:

```bash
npx vitest run tests/pipeline
```

Use these to lock in deterministic outputs (counts, sections, citations
present) before chasing eval-suite regressions.

## LLM evals (promptfoo)

This is the suite that catches regressions in the agent's actual behaviour —
hallucinations, missing citations, refusal-class drift, multi-turn breakage.
46 cases across UC-1..UC-7, a cross-cutting safety floor, and 8 multi-turn
conversations. Latest scoreboard lives in `agent/EVAL_RESULTS.md`.

### How the suite is laid out

```
evals/
├── config.yaml                          # provider + tests roll-up
├── providers/conversation-provider.mjs  # multi-turn HTTP provider
├── tests/
│   ├── uc1-previsit.yaml          (6 cases)
│   ├── uc2-delta.yaml             (4)
│   ├── uc3-meds-ddi.yaml          (4)
│   ├── uc4-labs.yaml              (4)
│   ├── uc5-allergies.yaml         (4)
│   ├── uc6-vitals.yaml            (4)
│   ├── uc7-refusal.yaml           (4)
│   ├── safety-floor.yaml          (8 cross-cutting)
│   └── conversations.yaml         (8 multi-turn)
└── fixtures/                            # consumed by the offline vitest evals
```

Every assertion is **objective**: it inspects an exact tool-call citation
prefix (`tool:<name>:row-…`) or an exact keyword/regex. There are no
vibe-checks ("does this *feel* right"). When an assertion fires, it points
at a concrete output property.

### Prerequisites

1. The agent service is running and reachable at the URL `config.yaml`
   targets — by default `http://localhost:3030/chat`. Run `npm run dev` in a
   second terminal (override `AGENT_SERVICE_PORT=3030` or change the URL in
   `config.yaml` if you prefer the default 3000).
2. `AGENTFORGE_JWT_SECRET` is the same value the running sidecar booted with.
3. The patient under test exists in OpenEMR. The default fixture targets
   Petrina Douglas (Synthea-seeded): `pid=9`, `uuid=a1abbe04-7c21-4882-b42c-38a0611ea6ca`.
4. A real LLM key is available (`OPENROUTER_API_KEY`).

### One-shot run

```bash
cd agent
set -a && . ./.env.local && set +a
export EVAL_PATIENT_UUID=a1abbe04-7c21-4882-b42c-38a0611ea6ca
export EVAL_PID=9
export EVAL_JWT_TTL=3600
export EVAL_JWT=$(node scripts/mint-eval-jwt.mjs)

npm run eval
# or, with extra knobs:
./node_modules/.bin/promptfoo eval \
  --config evals/config.yaml \
  --no-cache \
  --output /tmp/eval-results.json
```

`scripts/mint-eval-jwt.mjs` mints a 5-minute (or `EVAL_JWT_TTL`-second) HS256
JWT signed with `AGENTFORGE_JWT_SECRET`. Bump the TTL when you expect a long
run.

### Useful flags while iterating

| Need | Flag |
|---|---|
| Run only one group | `--filter-description "UC-3"` |
| Re-run only the previously failing cases | `--filter-failing /tmp/eval-results.json` |
| Bypass the prompt-cache while debugging assertions | `--no-cache` |
| Crank parallelism (LLM-bound) | `--max-concurrency 8` (default 4) |
| Open the HTML viewer | `./node_modules/.bin/promptfoo view` |
| Use a faster follow-up model | `AGENTFORGE_FOLLOWUP_MODEL=openai/gpt-4o-mini` (any OpenRouter slug) before booting the sidecar |

### Reading the output

`promptfoo` prints a green/red table per case. The HTML viewer
(`promptfoo view`) gives you the full prompt, the agent's response, the
tool-call trace, and the failed assertion. Pin failures back to:

- **Tool citation regex misfires** → fix the assertion in `evals/tests/`.
- **Real fabrication / wrong-tool-call** → fix the agent in `src/`.
- **Refusal-class regressions** → check `src/graph/nodes/refusalRouter.ts`.
- **DDI / allergy / dose** → check `src/verification/ClinicalRuleEngine.ts`
  and `data/`.

The latest run summary in [`EVAL_RESULTS.md`](../EVAL_RESULTS.md) walks
through which fixes flipped which cases — useful as a worked example.

### Speed-up runway

Bottleneck is concurrency-bound LLM I/O. Stacking these typically lands the
full suite in **3–4 min**:

1. `--max-concurrency 8` (default 4)
2. `AGENTFORGE_FOLLOWUP_MODEL=openai/gpt-4o-mini` (or any cheaper OpenRouter slug) before booting the sidecar
3. Drop `--no-cache` once assertions are stable
4. `--filter-description "UC-3"` while debugging a single group

### CI integration (sketch)

The eval suite is **not** wired into the default `npm test`. To gate a PR on
it:

```yaml
# .github/workflows/agent-eval.yml (sketch)
- run: npm install
  working-directory: agent
- run: npm run dev &  # background
  working-directory: agent
  env: { STUB_PLANNER: 'false', AGENTFORGE_JWT_SECRET: ${{ secrets.AGENTFORGE_JWT_SECRET }} }
- run: ./node_modules/.bin/wait-on http://localhost:3000/healthz
- run: npm run eval
  working-directory: agent
  env:
    AGENTFORGE_JWT_SECRET: ${{ secrets.AGENTFORGE_JWT_SECRET }}
    OPENROUTER_API_KEY:    ${{ secrets.OPENROUTER_API_KEY }}
```

Run cost is real — budget tens of cents per full run (Haiku/`gpt-4o-mini` at
46 cases). Trigger on PR label rather than every push if cost is a concern.

## Adding a new test case

| Goal | Where |
|---|---|
| New tool / refactor logic | `tests/unit/<area>/*.test.ts` |
| New route or middleware behaviour | `tests/integration/routes/*.test.ts` |
| New deterministic clinical assertion (no LLM) | `tests/pipeline/*.test.ts` + a fixture under `evals/fixtures/` |
| New use case for the LLM agent | A new `evals/tests/uc<N>-*.yaml`, register it in `evals/config.yaml` |
| New cross-cutting invariant ("agent must never X") | `evals/tests/safety-floor.yaml` |
| New multi-turn flow | `evals/tests/conversations.yaml` |

When you add a promptfoo case, prefer **citation-prefix** and **regex**
assertions over LLM-graded `llm-rubric`. Objective assertions are stable;
graded ones drift run-to-run.
