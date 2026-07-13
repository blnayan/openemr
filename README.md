[![Syntax Status](https://github.com/openemr/openemr/actions/workflows/syntax.yml/badge.svg)](https://github.com/openemr/openemr/actions/workflows/syntax.yml)
[![Styling Status](https://github.com/openemr/openemr/actions/workflows/styling.yml/badge.svg)](https://github.com/openemr/openemr/actions/workflows/styling.yml)
[![Testing Status](https://github.com/openemr/openemr/actions/workflows/test.yml/badge.svg)](https://github.com/openemr/openemr/actions/workflows/test.yml)
[![JS Unit Testing Status](https://github.com/openemr/openemr/actions/workflows/js-test.yml/badge.svg)](https://github.com/openemr/openemr/actions/workflows/js-test.yml)
[![PHPStan](https://github.com/openemr/openemr/actions/workflows/phpstan.yml/badge.svg)](https://github.com/openemr/openemr/actions/workflows/phpstan.yml)
[![Rector](https://github.com/openemr/openemr/actions/workflows/rector.yml/badge.svg)](https://github.com/openemr/openemr/actions/workflows/rector.yml)
[![ShellCheck](https://github.com/openemr/openemr/actions/workflows/shellcheck.yml/badge.svg)](https://github.com/openemr/openemr/actions/workflows/shellcheck.yml)
[![Docker Compose Linting](https://github.com/openemr/openemr/actions/workflows/docker-compose-lint.yml/badge.svg)](https://github.com/openemr/openemr/actions/workflows/docker-compose-lint.yml)
[![Dockerfile Linting](https://github.com/openemr/openemr/actions/workflows/hadolint.yml/badge.svg)](https://github.com/openemr/openemr/actions/workflows/hadolint.yml)
[![Isolated Tests](https://github.com/openemr/openemr/actions/workflows/isolated-tests.yml/badge.svg)](https://github.com/openemr/openemr/actions/workflows/isolated-tests.yml)
[![Inferno Certification Test](https://github.com/openemr/openemr/actions/workflows/inferno-test.yml/badge.svg)](https://github.com/openemr/openemr/actions/workflows/inferno-test.yml)
[![Composer Checks](https://github.com/openemr/openemr/actions/workflows/composer.yml/badge.svg)](https://github.com/openemr/openemr/actions/workflows/composer.yml)
[![Composer Require Checker](https://github.com/openemr/openemr/actions/workflows/composer-require-checker.yml/badge.svg)](https://github.com/openemr/openemr/actions/workflows/composer-require-checker.yml)
[![API Docs Freshness Checks](https://github.com/openemr/openemr/actions/workflows/api-docs.yml/badge.svg)](https://github.com/openemr/openemr/actions/workflows/api-docs.yml)
[![codecov](https://codecov.io/gh/openemr/openemr/graph/badge.svg?token=7Eu3U1Ozdq)](https://codecov.io/gh/openemr/openemr)

[![Backers on Open Collective](https://opencollective.com/openemr/backers/badge.svg)](#backers) [![Sponsors on Open Collective](https://opencollective.com/openemr/sponsors/badge.svg)](#sponsors)

# OpenEMR

[OpenEMR](https://open-emr.org) is a Free and Open Source electronic health records and medical practice management application. It features fully integrated electronic health records, practice management, scheduling, electronic billing, internationalization, free support, a vibrant community, and a whole lot more. It runs on Windows, Linux, Mac OS X, and many other platforms.

### Contributing

OpenEMR is a leader in healthcare open source software and comprises a large and diverse community of software developers, medical providers and educators with a very healthy mix of both volunteers and professionals. [Join us and learn how to start contributing today!](https://open-emr.org/wiki/index.php/FAQ#How_do_I_begin_to_volunteer_for_the_OpenEMR_project.3F)

> Already comfortable with git? Check out [CONTRIBUTING.md](CONTRIBUTING.md) for quick setup instructions and requirements for contributing to OpenEMR by resolving a bug or adding an awesome feature 😊.

### Support

Community and Professional support can be found [here](https://open-emr.org/wiki/index.php/OpenEMR_Support_Guide).

Extensive documentation and forums can be found on the [OpenEMR website](https://open-emr.org) that can help you to become more familiar about the project 📖.

### Reporting Issues and Bugs

Report these on the [Issue Tracker](https://github.com/openemr/openemr/issues). If you are unsure if it is an issue/bug, then always feel free to use the [Forum](https://community.open-emr.org/) and [Chat](https://www.open-emr.org/chat/) to discuss about the issue 🪲.

### Reporting Security Vulnerabilities

Check out [SECURITY.md](.github/SECURITY.md)

### API

Check out [API_README.md](API_README.md)

### Docker

Check out [DOCKER_README.md](DOCKER_README.md)

### FHIR

Check out [FHIR_README.md](FHIR_README.md)

### For Developers

If using OpenEMR directly from the code repository, then the following commands will build OpenEMR (Node.js version 24.* is required) :

```shell
composer install --no-dev
npm install
npm run build
composer dump-autoload -o
```

### AgentForge Week 2 Quick Start

This fork ships the AgentForge clinical co-pilot — a Node sidecar
(under `agent/`) that wires together a LangGraph supervisor, a
hybrid Pinecone + BM25 retriever over the ADA Standards of Care
guideline corpus, an OpenRouter-backed LLM, and a PHI-redacted
LangSmith trace pipeline. The agent talks to OpenEMR over FHIR R4
plus a JWT-scoped sidecar endpoint for extracted-document storage.

#### Local development

```shell
# 1. Generate a local .env for the sidecar.
cp agent/.env.example agent/.env.local
# Fill in real values (see env-var table below).

# 2. Start the full stack (OpenEMR + agent + Pinecone-less retrieval if no key).
cd docker/development-easy
docker compose -f docker-compose.yml -f docker-compose.agentforge.yml up -d --wait

# 3. (Optional) one-shot guideline ingest into Pinecone.
docker compose exec agentforge \
    env AGENTFORGE_GUIDELINES_INGEST=1 npm run ingest:guidelines

# 4. (Optional) seed the 6 fixture demo patients + pre-extracted JSON.
docker compose exec openemr \
    php contrib/agentforge/seed_demo_pdf_patients.php
node agent/scripts/seed-demo-fixtures.mjs
```

The agent listens on `http://localhost:3030/healthz` (mapped from the
container's `AGENT_SERVICE_PORT`). On boot it:

1. Validates required env vars (fail-fast on missing PHI redaction salt).
2. Polls OpenEMR's FHIR `metadata` endpoint until ready (cap ~90 s).
3. Runs the guideline ingest if `AGENTFORGE_GUIDELINES_INGEST=1`
   (idempotent — Pinecone is queried first, ingest is skipped when
   the chunk count already matches the committed corpus size).
4. Runs the demo-fixture ingest if `AGENTFORGE_FIXTURE_INGEST=1`
   (idempotent — skipped when sidecar rows for `AGENTFORGE-DEMO-PDF-`
   already exist).
5. Bootstrap step results are surfaced on `GET /bootstrap-status`.

#### Railway deploy

A push to a Railway-linked branch deploys two services: the existing
OpenEMR PHP image and the agent service (built from `agent/Dockerfile`,
configured via `agent/railway.json`). Boot order:

1. `auto_configure.php` runs OpenEMR migrations.
2. The same script seeds Synthea demo patients (gate:
   `OE_DEMO_SEED=1` or `RAILWAY_ENVIRONMENT` non-empty).
3. The same script seeds the 1-2 demo-PDF patients (gate:
   `AGENTFORGE_DEMO_PDF_SEED=1` or `RAILWAY_ENVIRONMENT` non-empty).
4. Railway starts the agent service.
5. The agent's bootstrap module runs the readiness probe + ingests.
   On Railway both `AGENTFORGE_GUIDELINES_INGEST` and
   `AGENTFORGE_FIXTURE_INGEST` auto-default to `1` when
   `RAILWAY_ENVIRONMENT` is set, so the deploy lands on a fully
   demo-ready service without manual one-shot commands.

Bootstrap failures never block server start — the agent always
listens on `/healthz` and `/bootstrap-status` even when ingests fail
or OpenEMR is unreachable.

#### Required environment variables

| Variable | Purpose |
|---|---|
| `AGENTFORGE_JWT_SECRET` | HS256 secret (>= 32 chars) for the JWT bridge between OpenEMR PHP and the agent. |
| `AGENTFORGE_PHI_REDACTION_SALT` | **REQUIRED.** HMAC salt for the PHI redactor wrapping LangSmith. The redactor singleton throws on first use when unset. |
| `AGENTFORGE_SERVICE_URL` | OpenEMR-side URL of the agent service (e.g. `http://agentforge:3000` inside Docker). |
| `OPENEMR_FHIR_BASE_URL` | Where the agent reaches FHIR (`/apis/default/fhir`). |
| `OPENEMR_OAUTH_BASE_URL` | Where the agent posts the SMART backend-services token request. |
| `OPENEMR_FHIR_CLIENT_ID` | Registered SMART system client id. |
| `OPENEMR_FHIR_PRIVATE_KEY_PATH` | RS384 PEM the agent signs the OAuth `client_assertion` with. |
| `OPENROUTER_API_KEY` | OpenRouter API key — single provider for chat + VLM extraction. |
| `OPENROUTER_BASE_URL` | Optional override; defaults to `https://openrouter.ai/api/v1`. |
| `OPENROUTER_REFERER` / `OPENROUTER_APP_TITLE` | Optional OpenRouter attribution headers. |
| `AGENTFORGE_MODEL` | Chat model slug for the supervisor + clinical-data tool calls (e.g. `anthropic/claude-haiku-4.5`). |
| `OPENROUTER_VLM_MODEL` | VLM model slug for document extraction. Must support vision + tool-calling on OpenRouter (e.g. `google/gemini-2.5-flash`, `anthropic/claude-haiku-4.5`). |
| `PINECONE_API_KEY` | Pinecone API key for the guideline retrieval index. |
| `PINECONE_INDEX_NAME` | Defaults to `agentforge-guidelines-v1`. |
| `PINECONE_EMBED_MODEL` | Pinecone integrated-index embed model (defaults to `llama-text-embed-v2`). |
| `PINECONE_RERANK_MODEL` | Primary rerank model (defaults to `bge-reranker-v2-m3`). |
| `PINECONE_RERANK_FALLBACK_MODEL` | Fallback rerank model when primary fails. |
| `LANGSMITH_API_KEY` | LangSmith trace observability. Leave blank to disable. |
| `LANGSMITH_PROJECT` | LangSmith project name. |
| `AGENT_SERVICE_PORT` | Defaults to `3000`; Railway overrides via `$PORT`. |
| `AGENTFORGE_GUIDELINES_INGEST` | `=1` to run guideline ingest at boot. Auto-set to `1` on Railway. |
| `AGENTFORGE_FIXTURE_INGEST` | `=1` to run demo-fixture ingest at boot. Auto-set to `1` on Railway. |
| `OE_DEMO_SEED` | `=1` to seed Synthea patients (auto-set on Railway). |
| `AGENTFORGE_DEMO_PDF_SEED` | `=1` to seed the 1-2 demo-PDF patients (auto-set on Railway). |
| `OPENEMR_SIDECAR_BASE_URL` | Optional override for the OpenEMR origin the agent uses to reach `interface/agentforge/sidecar.php`. Derived from `OPENEMR_FHIR_BASE_URL` when unset. |

`agent/.env.example` mirrors this list with blank values and inline
comments. Never commit a filled-in `.env.local`.

### Contributors

This project exists thanks to all the people who have contributed. [[Contribute]](CONTRIBUTING.md).
<a href="https://github.com/openemr/openemr/graphs/contributors"><img src="https://opencollective.com/openemr/contributors.svg?width=890" /></a>


### Sponsors

Thanks to our [ONC Certification Major Sponsors](https://www.open-emr.org/wiki/index.php/OpenEMR_Certification_Stage_III_Meaningful_Use#Major_sponsors)!


### License

[GNU GPL](LICENSE)
