# Patient Dashboard SPA — SMART launch entry

This directory holds the PHP entry point for the React + TypeScript patient
dashboard SPA. The bundle itself lives at
`public/assets/patient-dashboard/` and is built from the `patient-dashboard/`
workspace at the repo root.

## SMART client registration (one-time per environment)

The SPA is a public PKCE SMART-on-FHIR client, registered with
`skip_ehr_launch_authorization_flow=1` so the user never sees a consent
prompt during EHR launch. Run the idempotent registration script from
inside the openemr container:

```sh
docker compose -f docker/development-easy/docker-compose.yml exec openemr \
    php contrib/util/register_dashboard_client.php
```

The script:

1. Inserts (or updates) an `oauth_clients` row with `client_id =
   patient-dashboard-spa`, the right scopes, redirect URIs, and the trusted
   skip-auth flag.
2. Ensures the global `oauth_ehr_launch_authorization_flow_skip` is set to
   `1` (without it, the per-client skip flag is ignored).

Re-run the script any time the redirect URIs, scopes, or client_id change.

## Build + propagate the bundle

The Vite build emits the bundle into `public/assets/patient-dashboard/`. In
the dev-easy stack `public/assets` is a Docker named volume rather than a
bind mount, so the bundle must be copied into the running container after
each build:

```sh
cd patient-dashboard
npm run build
docker cp public/assets/patient-dashboard/index.js \
    development-easy-openemr-1:/var/www/localhost/htdocs/openemr/public/assets/patient-dashboard/index.js
docker cp public/assets/patient-dashboard/index.html \
    development-easy-openemr-1:/var/www/localhost/htdocs/openemr/public/assets/patient-dashboard/index.html
```

## Reaching the dashboard

Click the "Dashboard" tab from any patient chart. That tab is wired in
`interface/main/tabs/menu/menus/patient_menus/standard.json` and now points
at `interface/patient_file/summary/dashboard/index.php`.

The PHP entry point handles three modes on the same URL:

- No SMART query params: mints a `SMARTLaunchToken` from the active session
  and redirects to itself with `?iss=…&launch=…`.
- `?iss=&launch=`: serves the SPA shell. The SPA's `useAuth()` hook
  generates PKCE and redirects to `/oauth2/default/authorize`.
- `?code=&state=`: serves the SPA shell again; the SPA exchanges the code
  for tokens and renders.

The legacy `interface/patient_file/summary/demographics.php` is left on
disk as an unlinked fallback.
