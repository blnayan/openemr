# OpenEMR — Local Docker Setup

Steps to run this OpenEMR checkout locally using the bundled `development-easy`
Docker stack. The repository is bind-mounted into the container, so edits on
the host appear inside OpenEMR immediately.

## Prerequisites

- Docker Engine 20.10+ and Docker Compose v2 (`docker compose ...`).
- Free local TCP ports: `8300`, `9300`, `8310`, `8320`, `8025`, `1025`,
  `4444`, `7900`, `5984`, `6984`. Override any of them via the `WT_*`
  environment variables listed in `docker/development-easy/docker-compose.yml`
  if they collide.
- ~4 GB free disk for images and named volumes.

## Start the stack

From the repository root:

```bash
cd docker/development-easy
docker compose up --detach --wait
```

`--wait` blocks until the healthchecks pass. The first boot pulls images and
runs the OpenEMR auto-installer; expect 3–5 minutes before the app is ready.

Verify everything is up:

```bash
docker compose ps
```

All services (`openemr`, `mysql`, `phpmyadmin`, `couchdb`, `openldap`,
`mailpit`, `selenium`) should report `running` and the `openemr` and `mysql`
rows should show `healthy`.

## Service URLs

| Service          | URL                          | Credentials              |
|------------------|------------------------------|--------------------------|
| OpenEMR (HTTP)   | http://localhost:8300/       | `admin` / `pass`         |
| OpenEMR (HTTPS)  | https://localhost:9300/      | `admin` / `pass`         |
| phpMyAdmin       | http://localhost:8310/       | `root` / `root`          |
| Mailpit (UI)     | http://localhost:8025/       | —                        |
| Selenium VNC     | http://localhost:7900/       | password `openemr123`    |
| CouchDB          | http://localhost:5984/_utils | `admin` / `password`     |

The HTTPS endpoint uses a self-signed cert; accept the browser warning.

## Common commands

Run from `docker/development-easy/`.

```bash
# Tail application logs
docker compose logs -f openemr

# View the PHP error log
docker compose exec openemr /root/devtools php-log

# Open a shell inside the OpenEMR container
docker compose exec openemr bash

# Run the test suites (see CLAUDE.md / CONTRIBUTING.md for the full list)
docker compose exec openemr /root/devtools unit-test
docker compose exec openemr /root/devtools clean-sweep-tests
```

## Stop / reset

```bash
# Stop containers (data preserved)
docker compose stop

# Stop and remove containers (data preserved in named volumes)
docker compose down

# Full reset — wipes the database and all volumes
docker compose down --volumes
```

After `down --volumes`, the next `up` will reinstall OpenEMR from scratch.

## Troubleshooting

- **Port already in use:** export the matching `WT_*` variable before
  `docker compose up`, e.g. `WT_HTTP_PORT=8400 docker compose up -d --wait`.
- **`unhealthy` openemr container:** check `docker compose logs openemr`. The
  installer can take several minutes on first run — re-check after the
  `start_period` (3 min) elapses.
- **Stale assets after pulling new code:** `docker compose restart openemr`
  usually suffices; for dependency changes, run
  `docker compose exec openemr composer install` and/or
  `docker compose exec openemr npm install`.
