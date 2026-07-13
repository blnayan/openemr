# Vendored Synthea sample data

`synthea_sample_data_csv.zip` is the upstream
[Synthea sample-data 100-patient CSV pack][upstream] vendored into the
repo so the AgentForge demo seeder runs **without any outbound network**.

[upstream]: https://synthetichealth.github.io/synthea-sample-data/downloads/latest/synthea_sample_data_csv_latest.zip

| | |
|---|---|
| Source URL | `https://synthetichealth.github.io/synthea-sample-data/downloads/latest/synthea_sample_data_csv_latest.zip` |
| Snapshot date | 2026-04-30 |
| Bytes (compressed) | 8,832,318 |
| Bytes (extracted) | ~107 MB |
| Patients | 117 (the upstream pack ships a few extras over 100) |
| CSV files | 18 (`patients.csv`, `encounters.csv`, `conditions.csv`, `allergies.csv`, `medications.csv`, `observations.csv`, `immunizations.csv`, `procedures.csv`, `careplans.csv`, `claims.csv`, `claims_transactions.csv`, `imaging_studies.csv`, `devices.csv`, `supplies.csv`, `payers.csv`, `payer_transitions.csv`, `providers.csv`, `organizations.csv`) |
| SHA-256 | see `synthea_sample_data_csv.zip.sha256` |

The seeder ([`SyntheaDownloader`](../lib/synthea_download.php)) extracts this
zip into `sites/<site>/documents/agentforge-synthea/csv/` on first run
and reuses the extracted files thereafter. Network access is **off by
default** — set `AGENTFORGE_SYNTHEA_ALLOW_DOWNLOAD=1` to opt in to fetching
a newer snapshot from upstream if this file is ever removed.

## Refreshing the snapshot

Periodically (or when MITRE publishes a Synthea release that adds patients
or fixes a known issue) refresh the vendored copy:

```bash
curl -sLk -o contrib/agentforge/data/synthea_sample_data_csv.zip \
  https://synthetichealth.github.io/synthea-sample-data/downloads/latest/synthea_sample_data_csv_latest.zip
sha256sum contrib/agentforge/data/synthea_sample_data_csv.zip \
  > contrib/agentforge/data/synthea_sample_data_csv.zip.sha256
```

Then re-run the seeder to make sure the new pack still loads cleanly:

```bash
docker compose exec openemr \
  php /var/www/localhost/htdocs/openemr/contrib/agentforge/seed_demo_data.php --reset --limit=5
```

## Why vendor instead of fetching at runtime

- **No network at boot.** Railway containers don't need outbound HTTPS to
  github.io to come up; the demo works in air-gapped environments.
- **Reproducibility.** The SHA-256 sidecar pins what every machine sees, so
  Promptfoo eval baselines stay stable when MITRE updates "latest".
- **Speed.** No download on first seed.

The cost is ~9 MB of repo size, which is acceptable for a single-purpose
data file that changes only on deliberate refresh. (The previous FHIR-bundle
pack was ~37 MB; switching to CSV cut the vendored payload by 75 %.)

## Why CSV instead of FHIR bundles

The earlier vendored pack was the FHIR R4 bundle archive (one JSON
transaction Bundle per patient). The CSV pack carries the same patient
universe in 18 flat files where rows reference each other by UUID. For our
seeder this is a better fit:

- **Smaller on disk** — 9 MB vs 37 MB compressed.
- **Streamable** — `fgetcsv` parses one row at a time, so the 15 MB
  `observations.csv` and similarly large files never need to be held in
  memory all at once.
- **Easier to extend** — `immunizations.csv`, `procedures.csv`,
  `providers.csv`, and `organizations.csv` are now trivially available
  if a future plan wants to load them.
