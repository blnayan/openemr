# Deployment

The sidecar is packaged as a single Docker image (`agent/Dockerfile`) that
runs on Node 22. It is designed to drop straight into Railway, but any
container host with outbound HTTPS will do.

## What you're deploying

- A Fastify HTTP service on `$PORT` (Railway-injected) or
  `$AGENT_SERVICE_PORT` (default `3000`).
- `/healthz` is unauthenticated — wire it to your platform's health probe.
- Everything else requires a 120-second HS256 JWT minted by the OpenEMR
  PHP host using the **same** `AGENTFORGE_JWT_SECRET`.
- The sidecar fetches a SMART backend-services access token from OpenEMR
  using an RS384-signed `client_assertion`. The matching public JWK must be
  registered in `oauth_clients.jwks` ahead of time.

## Build & run locally with Docker

```bash
cd agent
docker build -t agentforge:local .
docker run --rm -p 3000:3000 \
  --env-file .env.local \
  -v "$(pwd)/secrets:/app/secrets:ro" \
  agentforge:local
```

`Dockerfile` highlights:

- Two stages — `deps` runs `npm ci`, `runtime` copies `node_modules` + `src`
  + `data` and runs as a non-root `agent` user.
- No compile step. The CMD is `tsx src/server.ts`. `npm run build` is a
  type-check only and is **not** part of the image build.
- `HEALTHCHECK` hits `/healthz` every 15 s.
- `EXPOSE 3000`. Override with `AGENT_SERVICE_PORT` or, on Railway, `PORT`.

## Railway

`railway.json` already pins:

```jsonc
{
  "build":  { "builder": "DOCKERFILE", "dockerfilePath": "Dockerfile" },
  "deploy": {
    "startCommand": "node_modules/.bin/tsx src/server.ts",
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 5
  }
}
```

End-to-end Railway setup, the first time:

1. **Create the project & service.** Point it at this repo, root directory
   `agent/`. Railway picks up `railway.json` and the `Dockerfile`.
2. **Set the required secrets** (Project → Variables):

   | Variable | Notes |
   |---|---|
   | `AGENTFORGE_JWT_SECRET` | `openssl rand -hex 32`. Must match what OpenEMR's PHP host signs JWTs with. |
   | `OPENROUTER_API_KEY` | OpenRouter API key. Get one at https://openrouter.ai/keys. |
   | `OPENEMR_FHIR_BASE_URL` | The internal Railway URL for the OpenEMR service, e.g. `http://openemr.railway.internal/apis/default/fhir`. |
   | `OPENEMR_OAUTH_BASE_URL` | Same host, `/oauth2/default`. |
   | `OPENEMR_OAUTH_PUBLIC_BASE_URL` | The **publicly-advertised** token URL — what OpenEMR's `.well-known/smart-configuration` says. The `aud` of the `client_assertion` JWT must match this exactly. |
   | `OPENEMR_FHIR_CLIENT_ID` | Output of `setup_system_client.php`. |
   | `OPENEMR_FHIR_PRIVATE_KEY_PATH` | `/app/secrets/private.pem` if you mount the file, **or** drop the path and use `OPENEMR_FHIR_PRIVATE_KEY_PEM` to inline the PEM as an env var. |
   | `OPENEMR_FHIR_TLS_INSECURE` | Must be `0` or unset in production. |
   | `LANGFUSE_SECRET_KEY`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_BASE_URL` | Optional; ship traces to Langfuse. |
   | `AGENTFORGE_MODEL` | Override the default `anthropic/claude-haiku-4.5`. Any OpenRouter slug works (e.g. `openai/gpt-4o-mini`, `google/gemini-2.5-flash`). |
3. **Generate and register the SMART keypair:**
   ```bash
   # Locally
   node scripts/gen-keys.mjs                           # creates secrets/{private.pem,public.jwk,jwks.json}

   # In OpenEMR (PHP container)
   docker compose exec openemr php contrib/agentforge/setup_system_client.php \
     --jwks-file=/var/www/localhost/htdocs/openemr/agent/secrets/jwks.json
   ```
   On Railway, ship the private key one of two ways:
   - **File mount:** drop the PEM into `secrets/` (gitignored) and bake it
     into a side image, or use a Railway volume.
   - **Inline env var:** set `OPENEMR_FHIR_PRIVATE_KEY_PEM` to the PEM
     contents directly. The token provider prefers the inline form when set.
4. **Generate a domain** (Project → Settings → Networking) and confirm
   `https://<railway-url>/healthz` returns 200.
5. **Point OpenEMR at the sidecar** by setting `AGENTFORGE_SERVICE_URL` in
   the OpenEMR container to the internal Railway URL
   (`http://agentforge.railway.internal:3000`). The PHP `SseProxyHandler`
   reads it.

### Rotating the SMART keypair

```bash
node scripts/gen-keys.mjs --force
docker compose exec openemr php contrib/agentforge/setup_system_client.php \
  --jwks-file=/var/www/localhost/htdocs/openemr/agent/secrets/jwks.json
# Restart the sidecar to drop cached access tokens
```

Every cached access token is invalidated when you rotate. Schedule it during
a low-traffic window.

### Rotating `AGENTFORGE_JWT_SECRET`

Both sides must flip atomically — the sidecar and the OpenEMR PHP host. Drift
between them produces `unauthorized` on every chat turn until corrected. The
safest ordering is:

1. Mint the new secret.
2. Set it on the OpenEMR PHP env **and** on the sidecar env.
3. Restart both.

## Seed demo data on Railway

The agent is read-only against OpenEMR's FHIR endpoints, so a freshly
deployed stack with an empty patient table is a sidecar with nothing to say.
The Synthea seeder under [`contrib/agentforge/`](../../contrib/agentforge/README.md)
solves that — it ships a vendored ~9 MB CSV pack (117 synthetic patients, no
PHI, no network) and loads it through OpenEMR's normal services. For the
local-dev version of this section, see
[BUILD.md → Seed demo data](BUILD.md#seed-demo-data-synthea).

### Auto-seed on every Railway boot

`auto_configure.php` calls the seeder on every Railway boot — no operator
action needed. The seed is gated by a three-way resolver that defaults to
**on** in Railway and **off** everywhere else:

1. If `OE_DEMO_SEED` is explicitly set, that value wins (`1` = force seed,
   anything else = skip).
2. Else if `RAILWAY_ENVIRONMENT` is non-empty (Railway sets this on every
   deploy), the seeder runs.
3. Else (local `docker run`), the seeder is skipped.

Set these on the OpenEMR Railway service (not the sidecar):

| Variable | Default | Effect |
|---|---|---|
| `OE_DEMO_SEED` | unset | `1` forces seed-on, anything else forces seed-off — operator override always wins. |
| `OE_DEMO_SEED_LIMIT` | `10` | Patient cap. `0` or `all` loads every Synthea patient (~35 min — blocks the container healthcheck while seeding). |
| `AGENTFORGE_SYNTHEA_DIR` | `sites/<site>/documents/agentforge-synthea` | Where the vendored zip is extracted. Point at a Railway volume if you don't want re-extraction on every cold boot. |
| `AGENTFORGE_SYNTHEA_ALLOW_DOWNLOAD` | unset | When `1`/`true`/`yes`, the seeder will fall back to downloading the upstream zip if the vendored copy is missing. **Leave unset** so the demo never silently reaches for the network. |
| `AGENTFORGE_ADMIN_TOKEN` | unset | Enables the `POST /interface/agentforge/admin/refresh.php` endpoint described below. Without it the endpoint returns 404. |

Boot-time idempotence: every deploy reset+seeds, so demo state converges to
the vendored CSV's contents on every push. Edits made in the live container
are wiped on the next deploy — the demo is a reproducible fixture, not a
writable workspace.

### Resetting demo data on a live deploy

Three entry points, in increasing order of disruption:

#### 1. HTTP refresh endpoint (preferred — no shell access required)

```bash
curl -sSf -X POST \
  -H "X-AgentForge-Admin-Token: $AGENTFORGE_ADMIN_TOKEN" \
  "https://<railway-url>/interface/agentforge/admin/refresh.php"
```

Add `?reset=1` for a tear-down without re-seed. Returns 404 unless
`AGENTFORGE_ADMIN_TOKEN` is set on the OpenEMR service. The endpoint honours
`OE_DEMO_SEED_LIMIT` exactly the same way as the boot seeder.

A wrapper script ships with the repo:

```bash
OPENEMR_BASE_URL=https://<railway-url> \
AGENTFORGE_ADMIN_TOKEN=$TOKEN \
contrib/agentforge/refresh-demo.sh

# tear-down only
OPENEMR_BASE_URL=https://<railway-url> \
AGENTFORGE_ADMIN_TOKEN=$TOKEN \
contrib/agentforge/refresh-demo.sh --reset-only
```

The OpenEMR sidecar reads the same `AGENTFORGE_ADMIN_TOKEN` env var as the
agent service — keep them aligned, or the curl call gets rejected.

#### 2. `railway run` CLI

If you have shell access, the in-container CLI exposes the full flag
surface:

```bash
railway run php contrib/agentforge/seed_demo_data.php --reset
railway run php contrib/agentforge/seed_demo_data.php --reset-only
railway run php contrib/agentforge/seed_demo_data.php --reset --limit=0
```

#### 3. Container redeploy

`railway up` (or any push to the watched branch) re-runs the boot seeder.
Use this when the vendored CSV pack itself has changed and you want the
new fixture to take effect.

### Verifying the seed end-to-end

After a refresh, confirm the agent can actually see the data by hitting
FHIR with a fresh access token:

```bash
TOKEN=$(curl -sSf -X POST \
  -d "grant_type=password&username=admin&password=pass&client_id=<id>&scope=openid api:fhir" \
  https://<railway-url>/oauth2/default/token | jq -r .access_token)

PID_UUID="<uuid printed by seeder>"
BASE="https://<railway-url>/apis/default/fhir"

curl -sSf -H "Authorization: Bearer $TOKEN" "$BASE/Patient/$PID_UUID"
curl -sSf -H "Authorization: Bearer $TOKEN" "$BASE/Condition?patient=$PID_UUID&clinical-status=active"
curl -sSf -H "Authorization: Bearer $TOKEN" "$BASE/MedicationRequest?patient=$PID_UUID"
curl -sSf -H "Authorization: Bearer $TOKEN" "$BASE/Observation?patient=$PID_UUID&category=laboratory"
```

If those four return populated bundles, the agent will too. If the seeder
ran but FHIR is empty, the most common cause is an `OE_DEMO_SEED_LIMIT`
typo or a stale `AGENTFORGE_SYNTHEA_DIR` pointing at a volume that wasn't
wiped on the previous reset.

## Scaling & runtime knobs

- The sidecar holds conversation state in-process (single replica). Multi-
  replica deployments would need a shared store; out of scope for the
  current build.
- LangChain calls are I/O-bound. Going from 1 → 4 concurrent turns per
  replica yields more than going from 1 → 4 replicas.
- Memory floor is small (~120 MB idle). The 20-turn conversation cap and the
  PHI TTL job (every 5 min) keep heap predictable.
- Set `LOG_LEVEL=debug` only when reproducing a specific incident — it's
  noisy and PHI-redaction is best-effort, not perfect.

## What can go wrong in production

| Symptom | First place to look |
|---|---|
| `/healthz` returns 200 but `/chat` always 401 | `AGENTFORGE_JWT_SECRET` drift between OpenEMR PHP and sidecar. |
| Token fetch fails with `invalid_client` | Public JWK in `oauth_clients.jwks` doesn't match the private key the sidecar is signing with. Re-run `setup_system_client.php` after `gen-keys.mjs --force`. |
| Token fetch fails with `invalid_request` re: `aud` | `OPENEMR_OAUTH_PUBLIC_BASE_URL` doesn't match what OpenEMR advertises in `.well-known/smart-configuration`. |
| Tool calls return empty bundles for a real patient | The JWT carries the wrong `patient_uuid`. Confirm OpenEMR's PHP host is reading the right session pid → uuid map. |
| Sidebar in OpenEMR loads but no streaming | The PHP `SseProxyHandler` cannot reach `AGENTFORGE_SERVICE_URL`. Check Railway internal-network DNS or the SSL trust chain. |
| Latency P95 > 8 s | Open Langfuse and look at the `graph.turn` span breakdown. Most regressions land in `llm.planner` (model swap) or `tool.call.<name>` (FHIR slowdown). |

## Observability surface

When `LANGFUSE_SECRET_KEY` and `LANGFUSE_PUBLIC_KEY` are present, every:

- LangChain.js call (planner, judge, optional pre-visit polish), and
- `@traceable`-wrapped FHIR + token round-trip

ships to Langfuse under your configured project/workspace.

Without API keys, tracing export is a no-op — zero network calls go to
Langfuse. Treat it as opt-in, not as a default cost.

## Rollback

Railway keeps prior deploys. Roll back from the Railway UI. The sidecar
holds no persistent state of its own, so rollbacks are non-destructive.
