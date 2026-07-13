# AgentForge demo data seeder — Synthea CSV source

Loads the [Synthea sample-data 100-patient CSV pack][synthea] into OpenEMR
so Dr. M (or anyone running the demo) has rich, realistic charts to walk an
agent across. UC-1 in [`USERS.md`](../../USERS.md) is illustrative — Maria
González is a worked example, not a row in the database. The agent's
behaviour against any Synthea patient with active conditions, meds, and labs
exercises the same workflow.

The Synthea zip is **vendored in the repo** at
[`data/synthea_sample_data_csv.zip`](data/) — the seeder extracts it locally
and never reaches for the network unless `AGENTFORGE_SYNTHEA_ALLOW_DOWNLOAD=1`
is set.

[synthea]: https://synthetichealth.github.io/synthea-sample-data/

## What gets loaded

The pack contains **117 patients** (Synthea generates a few extras) across
18 CSV files. The loader streams them in dependency order and keeps
everything UC-1 cares about; everything else is skipped:

| Loaded | Skipped |
|---|---|
| `patients.csv` → `patient_data` | `claims.csv`, `claims_transactions.csv` |
| `encounters.csv` → `form_encounter` | `imaging_studies.csv` |
| `conditions.csv` → `lists` (active only — `STOP` empty) | `careplans.csv` |
| `allergies.csv` → `lists` (active only — `STOP` empty) | `devices.csv`, `supplies.csv` |
| `medications.csv` → `prescriptions` (with RxNorm) | `payers.csv`, `payer_transitions.csv` |
| `observations.csv` (CATEGORY=vital-signs) → `form_vitals` | `immunizations.csv` *(deferred)* |
| `observations.csv` (CATEGORY=laboratory) → `procedure_*` | `procedures.csv` *(deferred)* |
|  | `providers.csv`, `organizations.csv` |

`conditions.csv` rows whose SNOMED code matches Synthea's social-determinants
module (employment status, housing, education, transport, stress, social
isolation, refugee status, etc.) are dropped at load time so they do not
land on the OpenEMR problem list. The denylist is in
`SyntheaLoader::NON_MEDICAL_CONDITION_CODES` — extend it when a future
Synthea release surfaces new social-determinant codes.

Inserts route through OpenEMR services where they exist — `PatientService`,
`ConditionService`, `AllergyIntoleranceService`, `PrescriptionService`,
`EncounterService::insertEncounter`, `EncounterService::insertVital`. Direct
SQL is used only for the lab-result chain (no OpenEMR service exposes the
`procedure_order/_code/_report/_result` insert) and for the cascade delete on
reset (no service exposes a per-pid cascade).

Every loaded patient gets `pubpid` of the form `AGENTFORGE-<24-char Synthea
id>`. The reset path matches the `AGENTFORGE-` prefix.

## Running locally (development-easy Docker stack)

```bash
cd docker/development-easy
docker compose up --detach --wait

# First seed — extracts the vendored CSV zip into the cache dir; no network.
# Default cap: 10 patients (~3 min).
docker compose exec openemr \
    php /var/www/localhost/htdocs/openemr/contrib/agentforge/seed_demo_data.php

# Reset + re-seed with the default 10-patient cap (~3 min)
docker compose exec openemr \
    php /var/www/localhost/htdocs/openemr/contrib/agentforge/seed_demo_data.php --reset

# Reset + load every Synthea patient — 117 patients, ~35 min
docker compose exec openemr \
    php /var/www/localhost/htdocs/openemr/contrib/agentforge/seed_demo_data.php --reset --limit=0

# Smaller smoke test (first 5 patients)
docker compose exec openemr \
    php /var/www/localhost/htdocs/openemr/contrib/agentforge/seed_demo_data.php --reset --limit=5

# Tear down (no re-seed)
docker compose exec openemr \
    php /var/www/localhost/htdocs/openemr/contrib/agentforge/seed_demo_data.php --reset-only
```

`--limit` defaults to `10`. Pass `--limit=0` to load every patient; pass any
positive integer to cap to that many.

Then visit <http://localhost:8300>, log in `admin` / `pass`, and the patient
list shows your Synthea charts.

## Running on Railway (public-facing demo)

`auto_configure.php` runs the seeder automatically on every Railway boot. No
operator action is required after `railway up` — the install completes,
the seeder reset+seeds 10 patients, and the container starts serving.

The auto-seed is gated by a three-way resolver:

1. If `OE_DEMO_SEED` is explicitly set, the value wins (`1` = on,
   anything else = off). Operator override always wins.
2. Else if `RAILWAY_ENVIRONMENT` is non-empty (Railway sets this on every
   deploy), the seeder runs.
3. Else (local dev, plain `docker run`), the seeder is skipped.

This means: Railway gets zero-config auto-seeding; local dev keeps the
no-surprise behaviour where the demo only seeds when explicitly requested.

| Variable | Default | Effect |
|---|---|---|
| `OE_DEMO_SEED` | unset | When set: `1` = force seed on, anything else = force seed off. |
| `RAILWAY_ENVIRONMENT` | set automatically by Railway | When non-empty *and* `OE_DEMO_SEED` is unset, triggers auto-seed. |
| `OE_DEMO_SEED_LIMIT` | `10` | Cap on patients seeded. Set to `0` or `all` to load every Synthea patient (~35 min — blocks the container healthcheck during seed). |
| `AGENTFORGE_SYNTHEA_DIR` | `sites/<site>/documents/agentforge-synthea` | Where the vendored zip is extracted (sub-dir `csv/`). Override to point at a persistent volume if you don't want re-extraction on every cold boot. |
| `AGENTFORGE_SYNTHEA_ALLOW_DOWNLOAD` | unset | When set (`1`/`true`/`yes`), the seeder will fall back to downloading the upstream zip if the vendored copy is missing. Default is **off** so the demo never silently reaches for the network. |
| `AGENTFORGE_ADMIN_TOKEN` | unset | Enables the HTTP refresh endpoint described below. Without it, the endpoint returns 404. **Set this on Railway to enable live resets.** |

Boot-time idempotence: every Railway deploy reset+seeds, so demo state
converges to the vendored CSV's contents on every deploy. If an operator
edits demo data in the live container, those edits are wiped on next
deploy. The demo is a reproducible fixture, not a writable workspace.

## Resetting demo data on a live Railway deploy

Three orthogonal entry points, in increasing order of disruption:

### 1. HTTP endpoint (recommended — no shell access required)

`POST /interface/agentforge/admin/refresh.php` is a token-gated endpoint
that re-runs reset+seed in-place. Returns 404 when `AGENTFORGE_ADMIN_TOKEN`
is not set.

```bash
curl -sSf -X POST \
  -H "X-AgentForge-Admin-Token: $AGENTFORGE_ADMIN_TOKEN" \
  "https://<railway-url>/interface/agentforge/admin/refresh.php"
```

Add `?reset=1` to drop demo patients without re-seeding (tear-down only).

The endpoint honours `OE_DEMO_SEED_LIMIT` exactly the same way as the boot
seeder.

For convenience, [`refresh-demo.sh`](refresh-demo.sh) wraps the curl call:

```bash
OPENEMR_BASE_URL=https://<railway-url> \
AGENTFORGE_ADMIN_TOKEN=$TOKEN \
contrib/agentforge/refresh-demo.sh

# tear-down only
OPENEMR_BASE_URL=https://<railway-url> \
AGENTFORGE_ADMIN_TOKEN=$TOKEN \
contrib/agentforge/refresh-demo.sh --reset-only
```

### 2. `railway run` CLI

If you have shell access to the deployed service, the in-container CLI
gives you the full flag surface (custom `--limit`, `--cache-dir`, etc.):

```bash
railway run php contrib/agentforge/seed_demo_data.php --reset
railway run php contrib/agentforge/seed_demo_data.php --reset-only
railway run php contrib/agentforge/seed_demo_data.php --reset --limit=0
```

### 3. Container redeploy

Every Railway deploy re-runs the boot seeder, so `railway up` (or any
push to the watched branch) is itself a reset. Use this when the
vendored CSV pack itself has changed and you want the new fixture to
take effect.

## Verifying the seed against FHIR

The seeded UUIDs are real OpenEMR FHIR identifiers. Pick any patient and:

```bash
TOKEN=$(curl -sk -X POST \
  -d "grant_type=password&username=admin&password=pass&client_id=<id>&scope=openid api:fhir" \
  https://localhost:9300/oauth2/default/token | jq -r .access_token)

PID_UUID="<uuid printed by seeder>"
BASE="https://localhost:9300/apis/default/fhir"

curl -sk -H "Authorization: Bearer $TOKEN" "$BASE/Patient/$PID_UUID"
curl -sk -H "Authorization: Bearer $TOKEN" "$BASE/Condition?patient=$PID_UUID&clinical-status=active"
curl -sk -H "Authorization: Bearer $TOKEN" "$BASE/MedicationRequest?patient=$PID_UUID"
curl -sk -H "Authorization: Bearer $TOKEN" "$BASE/AllergyIntolerance?patient=$PID_UUID"
curl -sk -H "Authorization: Bearer $TOKEN" "$BASE/Observation?patient=$PID_UUID&category=laboratory"
curl -sk -H "Authorization: Bearer $TOKEN" "$BASE/Observation?patient=$PID_UUID&category=vital-signs"
curl -sk -H "Authorization: Bearer $TOKEN" "$BASE/Encounter?patient=$PID_UUID&_sort=-date"
```

## File layout

```
contrib/agentforge/
├── README.md                          ← you are here
├── seed_demo_data.php                 ← CLI entry point
├── refresh-demo.sh                    ← curl wrapper for the admin refresh endpoint
├── data/
│   ├── README.md                      ← provenance + how to refresh the snapshot
│   ├── synthea_sample_data_csv.zip    ← vendored ~9 MB Synthea CSV pack
│   └── synthea_sample_data_csv.zip.sha256
└── lib/
    ├── synthea_download.php           ← SyntheaDownloader (vendored-zip extractor)
    ├── SyntheaLoader.php              ← Synthea CSV → OpenEMR mapper
    ├── AppointmentScheduler.php       ← 4-week calendar generator
    └── DemoDataSeeder.php             ← seed() / reset() orchestration

interface/agentforge/admin/
└── refresh.php                        ← token-gated HTTP refresh endpoint
```

`auto_configure.php` reads `OE_DEMO_SEED`, `RAILWAY_ENVIRONMENT`, and
`OE_DEMO_SEED_LIMIT`, then runs the seeder after the install step completes.

## Why Synthea, not hand-crafted fixtures

Three hand-crafted patients (Maria González + two trust-model patients) were
the original seed and worked for the worked example in `USERS.md`. The
Synthea pack gives:

- **Volume** — 117 patients across 18 CSV files. The agent's tool fan-out
  and pagination get exercised on real-shape data.
- **Variety** — chronic-disease patients with decades of history, paediatric
  encounters, post-surgical patients, edge cases like deceased patients.
- **Reproducibility** — identical data on every machine; the URL is pinned
  to the `latest` synthea-sample-data release and the SHA-256 sidecar
  pins the exact bytes.
- **No PHI** — Synthea is fully synthetic, suitable for public demos and
  evals without BAA paperwork.

What we lose: the deterministic A1c-trend / atorvastatin-add story in UC-1
no longer matches a real database row. That's fine — UC-1 is a worked
example of a workflow, not a fixture spec. Any Synthea patient with active
diabetes, an A1c lab, and a recent statin prescription is a valid stand-in.

## Why CSV instead of FHIR bundles

The earlier vendored pack was the FHIR R4 bundle archive (one JSON
transaction Bundle per patient). Switching to the CSV pack:

- **Cuts the vendored payload** from ~37 MB → ~9 MB compressed.
- **Streams cleanly** — 18 flat files, parsed one row at a time with
  `fgetcsv`. The 15 MB `observations.csv` never sits in memory all at
  once.
- **Easier to extend** — `immunizations.csv`, `procedures.csv`,
  `providers.csv`, and `organizations.csv` are now structurally trivial
  to load if a future plan needs them.

## Adding or changing what gets loaded

The mapping logic lives in `lib/SyntheaLoader.php`, one method per Synthea
CSV file. To add a new file (e.g. `immunizations.csv`) or to adjust how
an existing one is shaped, edit that file. The reset path is keyed off the
`AGENTFORGE-` `pubpid` prefix (`SyntheaLoader::DEMO_PUBPID_PREFIX`); don't
change the prefix without also clearing whatever's already in the database.
