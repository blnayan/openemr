# Build & Local Development

Everything in this guide runs from `agent/` unless noted otherwise.

## Prerequisites

| Tool | Version | Why |
|---|---|---|
| Node.js | **≥ 22** (24 OK) | `engines.node` in `package.json`. The runtime uses `tsx` directly — no separate compile step is required for local dev. |
| npm | ≥ 10 | Lockfile committed (`package-lock.json`). |
| Docker | recent | Only required if you want OpenEMR + FHIR running locally. |
| OpenSSL | any | One-liner to generate the JWT secret. |

## First-time setup

```bash
cd agent
npm install
cp .env.example .env.local        # fill in the values described below
node scripts/gen-keys.mjs         # generates secrets/{private.pem,public.jwk,jwks.json}
```

`scripts/gen-keys.mjs` produces the RS384 keypair the sidecar uses to sign the
SMART backend-services `client_assertion` JWT. The matching public JWK has to
be registered in OpenEMR — see DEPLOYMENT.md for the registration step.

### Required env vars

The full template is in [`agent/.env.example`](../.env.example). At minimum
fill in:

| Variable | How to obtain |
|---|---|
| `AGENTFORGE_JWT_SECRET` | `openssl rand -hex 32` — must match what OpenEMR's `ScopedJwtMinter` uses. |
| `OPENROUTER_API_KEY` | OpenRouter API key. Get one at https://openrouter.ai/keys. |
| `OPENEMR_FHIR_BASE_URL` | Where the sidecar hits FHIR. `https://localhost:9300/apis/default/fhir` for the easy-dev compose. |
| `OPENEMR_OAUTH_BASE_URL` | Where the sidecar POSTs token requests. Same host, `/oauth2/default`. |
| `OPENEMR_OAUTH_PUBLIC_BASE_URL` | The `aud` claim in the `client_assertion` JWT. Often differs from the *internal* base URL once Docker networks are involved. |
| `OPENEMR_FHIR_CLIENT_ID` | The system client registered with `contrib/agentforge/setup_system_client.php`. |
| `OPENEMR_FHIR_PRIVATE_KEY_PATH` | Path to `secrets/private.pem` (or `/app/secrets/private.pem` inside the container). |

Optional but commonly set:

- `OPENEMR_FHIR_TLS_INSECURE=1` — dev only, bypasses TLS verification when
  the sidecar talks to OpenEMR's self-signed `https://localhost:9300`. **Must
  be unset in production.**
- `STUB_PLANNER=true` — bypass the LLM entirely; deterministic responses for
  offline demos and CI.
- `AGENTFORGE_PREVISIT_USE_LLM=1` — polish the deterministic pre-visit summary
  with an LLM call (~5–7 s extra).
- `LANGFUSE_SECRET_KEY` + `LANGFUSE_PUBLIC_KEY` — ship every LLM + FHIR span
  to Langfuse.

## Build commands

`package.json` defines:

```jsonc
{
  "build":  "tsc --noEmit",                  // type-check only — no JS emitted
  "dev":    "tsx --watch src/server.ts",     // live-reload local dev server
  "start":  "node --experimental-vm-modules dist/server.js",
  "test":   "vitest run",
  "test:unit":        "vitest run tests/unit",
  "test:integration": "vitest run tests/integration",
  "eval":   "promptfoo eval --config evals/config.yaml"
}
```

A few notes that surprise people:

- **There is no production compile step.** The Docker image runs `tsx
  src/server.ts` directly. `npm run build` only type-checks (`tsc --noEmit`) —
  treat it as a CI gate, not a build artifact producer.
- `tsconfig.json` is strict (`strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`). Failing `npm run build` on master is a hard
  stop.
- `vitest` runs in `forks` pool with a 20 s test timeout — see
  [`vitest.config.ts`](../vitest.config.ts).

## The dev loop

```bash
# Terminal 1 — start OpenEMR (only needed if you'll hit FHIR for real)
cd docker/development-easy
docker compose up --detach --wait
# OpenEMR at https://localhost:9300, login admin/pass

# Terminal 2 — agent sidecar
cd agent
npm run dev
# Fastify listens on :3000, /healthz unauthenticated, everything else needs JWT
```

Hit it with curl (see `README.md` for the one-liner) or, more usefully, open
the patient dashboard in OpenEMR — the `<agent-sidebar>` Web Component will
mount and proxy to the sidecar via `interface/agentforge/chat.php`.

### Type-check & lint before committing

```bash
npm run build            # tsc --noEmit
npm test                 # vitest run (unit + integration + offline evals)
```

There is no separate ESLint step in this package — TypeScript strict mode +
the test suite are the gate.

## Seed demo data (Synthea)

The agent is only as interesting as the charts it can read. The seeder under
[`contrib/agentforge/`](../../contrib/agentforge/README.md) loads a vendored
[Synthea sample-data][synthea] CSV pack (117 fully synthetic patients, no PHI,
no network) into OpenEMR's tables via the existing services
(`PatientService`, `ConditionService`, `AllergyIntoleranceService`,
`PrescriptionService`, `EncounterService`). After it runs, every chart shows
up via FHIR — which is what the agent and the eval suite actually consume.

[synthea]: https://synthetichealth.github.io/synthea-sample-data/

### Quick seed (default 10 patients, ~3 min)

From the **repo root** with `docker/development-easy` already up:

```bash
cd docker/development-easy
docker compose up --detach --wait

docker compose exec openemr \
    php /var/www/localhost/htdocs/openemr/contrib/agentforge/seed_demo_data.php
```

Sign in at <http://localhost:8300> as `admin` / `pass` and the patient list
shows the seeded charts. Every demo patient has `pubpid` of the form
`AGENTFORGE-<24-char-synthea-id>` so they're easy to spot and easy to wipe.

### Common variations

```bash
# Reset + re-seed the default 10 patients
docker compose exec openemr \
    php /var/www/localhost/htdocs/openemr/contrib/agentforge/seed_demo_data.php --reset

# Smaller smoke test (5 patients)
docker compose exec openemr \
    php /var/www/localhost/htdocs/openemr/contrib/agentforge/seed_demo_data.php --reset --limit=5

# Load every Synthea patient — 117 charts, ~35 min
docker compose exec openemr \
    php /var/www/localhost/htdocs/openemr/contrib/agentforge/seed_demo_data.php --reset --limit=0

# Tear down only (no re-seed)
docker compose exec openemr \
    php /var/www/localhost/htdocs/openemr/contrib/agentforge/seed_demo_data.php --reset-only
```

`--limit` defaults to `10`. `--limit=0` loads everything; the reset path keys
off the `AGENTFORGE-` `pubpid` prefix and only touches charts the seeder
itself created.

### Wiring the seed into the eval suite

The promptfoo cases in [TESTING.md](TESTING.md#llm-evals-promptfoo) target a
specific seeded patient via `EVAL_PATIENT_UUID` / `EVAL_PID`. After a seed
run, pick any chart from the OpenEMR patient list and read `pid` plus the
FHIR `Patient/<uuid>` from the URL bar (or query the database directly):

```bash
# pid + uuid for the first AGENTFORGE patient
docker compose exec openemr mysql -uopenemr -popenemr openemr -e \
  "SELECT pid, uuid FROM patient_data WHERE pubpid LIKE 'AGENTFORGE-%' LIMIT 1;"
```

Then export them before minting the eval JWT:

```bash
export EVAL_PID=<pid>
export EVAL_PATIENT_UUID=<uuid-from-the-row>
export EVAL_JWT=$(node scripts/mint-eval-jwt.mjs)
```

The `EVAL_RESULTS.md` scoreboard pins **Petrina Douglas** (`pid=9`, uuid
`a1abbe04-7c21-4882-b42c-38a0611ea6ca`) because that's the chart the
checked-in eval fixtures speak about. To make the suite pass at her exact
numbers you need her data — re-seeding with the default `--limit=10` keeps
her in the set.

### Where the data lives

```
contrib/agentforge/
├── README.md                          ← full reference, all flags
├── seed_demo_data.php                 ← CLI entry point
├── refresh-demo.sh                    ← curl wrapper for the live-deploy refresh endpoint
├── data/
│   └── synthea_sample_data_csv.zip    ← vendored ~9 MB CSV pack (no network needed)
└── lib/
    ├── SyntheaLoader.php              ← CSV → OpenEMR mapper, one method per Synthea file
    ├── AppointmentScheduler.php       ← 4-week calendar generator
    └── DemoDataSeeder.php             ← seed() / reset() orchestration
```

Adding a new Synthea file (e.g. `immunizations.csv`) means adding one method
to `SyntheaLoader.php`. Don't change the `AGENTFORGE-` `pubpid` prefix — the
reset path keys off it.

For the Railway-side equivalent (auto-seed on every boot, plus the
token-gated `POST /interface/agentforge/admin/refresh.php` endpoint), see
[DEPLOYMENT.md → Seed demo data on Railway](DEPLOYMENT.md#seed-demo-data-on-railway).

## Troubleshooting first-run failures

| Symptom | Likely cause |
|---|---|
| `Invalid agent config: AGENTFORGE_JWT_SECRET: String must contain at least 32 character(s)` | You skipped `cp .env.example .env.local` or forgot to source it. `set -a && . ./.env.local && set +a`. |
| `unauthorized` from `/chat` with a freshly minted JWT | Mismatch between the secret you minted with vs. the one in the sidecar process. They must be byte-identical. |
| FHIR token fetch fails with `401 invalid_client` | Either the public JWK in `oauth_clients.jwks` is stale (rotate via `node scripts/gen-keys.mjs --force` and re-register) or `OPENEMR_OAUTH_PUBLIC_BASE_URL` doesn't match what OpenEMR advertises. |
| FHIR calls hang for ~5 s then time out | TLS verification failing on a self-signed cert. In **dev only**, set `OPENEMR_FHIR_TLS_INSECURE=1`. |
| `tsx: command not found` when running `npm start` | `npm start` runs the compiled output. Use `npm run dev` for source, or build a real image. |
