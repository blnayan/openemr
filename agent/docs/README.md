# AgentForge — Developer Guide

Welcome. This is the operator's manual for the **AgentForge Clinical Co-Pilot**
sidecar that lives in `agent/`. It is a Node 22 / TypeScript Fastify service
that fronts an LLM agent (LangChain.js + LangGraph.js) over OpenEMR's FHIR API.

## What this service is

A read-only conversational agent for primary-care physicians. The PCP opens a
patient chart, types a question into the `<agent-sidebar>` Web Component, and
the agent answers with citations to specific FHIR rows in under ~8 s.

- **Trust model:** OpenEMR PHP mints a 120-second HS256 JWT scoped to one
  patient. The sidecar verifies it, calls FHIR with a SMART backend-services
  access token (separate, RS384-signed `client_assertion`), and never accepts
  `patient_uuid` from the request body.
- **Verification:** Three layers — (1) citation grounding, (2) clinical-rule
  engine (DDI / allergy / dose), (3) LLM-judge backstop.
- **Persistence:** In-process maps for conversation history and tool-result
  cache. Single replica; state is intentionally ephemeral (30-min TTL).
- **Observability:** Langfuse (`@traceable`) wrapping every LLM and FHIR
  round-trip when Langfuse API keys are configured.

## Where to start

| You want to… | Read |
|---|---|
| Get the service running on your laptop | [BUILD.md](BUILD.md) |
| Run unit / integration tests | [TESTING.md](TESTING.md) |
| Run the LLM eval suite (promptfoo) | [TESTING.md](TESTING.md#llm-evals-promptfoo) |
| Seed demo (Synthea) patients into OpenEMR | [BUILD.md](BUILD.md#seed-demo-data-synthea) (local) · [DEPLOYMENT.md](DEPLOYMENT.md#seed-demo-data-on-railway) (Railway) |
| Deploy to Railway or any container host | [DEPLOYMENT.md](DEPLOYMENT.md) |
| Skim the architecture | [archive/ARCHITECTURE.md](archive/ARCHITECTURE.md) |
| Read the original implementation plan | [archive/IMPLEMENTATION_PLAN.md](archive/IMPLEMENTATION_PLAN.md) |
| See the latest eval scoreboard | [../EVAL_RESULTS.md](../EVAL_RESULTS.md) |

## Source map

```
agent/
├── src/
│   ├── server.ts                 # Fastify bootstrap (buildServer / startServer)
│   ├── config.ts                 # Zod-validated env loader
│   ├── routes/                   # /chat, /conversation, /healthz
│   ├── middleware/verifyJwt.ts   # HS256 JWT gate (issuer/audience/scope)
│   ├── fhir/                     # FhirClient + OpenEmrTokenProvider (SMART backend)
│   ├── tools/                    # 8 read-only FHIR tools (citation IDs included)
│   ├── graph/                    # LangGraph nodes + runFollowup / runPrevisit
│   ├── llm/AgentLlmClient.ts     # Anthropic / OpenAI abstraction
│   ├── verification/             # Layer 1/2/3 verifier
│   ├── clinical/                 # BaselineHighlights, EncounterDiff (deterministic)
│   ├── db/                       # In-memory conversation repo + tool-result cache
│   ├── observability/PhiRedactor # log scrubbing
│   └── schemas/AnswerSchema.ts   # Zod contract for the structured answer
├── tests/                        # vitest — unit, integration, eval (offline)
├── promptfoo/                    # LLM eval suite (online, real LLM)
├── scripts/
│   ├── gen-keys.mjs              # RS384 keypair for SMART backend-services
│   └── mint-eval-jwt.mjs         # 5-min HS256 JWT for promptfoo / curl
├── data/                         # Static lookup tables (DDI, dose ranges)
├── secrets/                      # Generated keypair (gitignored)
├── Dockerfile                    # Two-stage Node 22 image
├── railway.json                  # Railway service config
└── docs/                         # ← you are here
```

## One-shot smoke test

```bash
cd agent
cp .env.example .env.local
# fill in AGENTFORGE_JWT_SECRET (openssl rand -hex 32), OPENROUTER_API_KEY
npm install
npm run dev                        # boots Fastify on :3000

# in another terminal
set -a && . ./.env.local && set +a
EVAL_JWT=$(node scripts/mint-eval-jwt.mjs)
curl -X POST http://localhost:3000/chat \
  -H "Authorization: Bearer $EVAL_JWT" \
  -H "Content-Type: application/json" \
  -d '{"question":"summarize this patient","conversation_id":null,"encounter_id":null,"mode":"previsit"}'
```

If you get a `200` back with a JSON body containing `summary` and `claims`,
the trust model and the LLM are wired correctly.
