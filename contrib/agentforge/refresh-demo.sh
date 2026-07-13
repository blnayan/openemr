#!/usr/bin/env bash

# AgentForge demo-refresh helper (Document Inbox rework).
#
# Posts to interface/agentforge/admin/refresh.php to reset, re-seed the
# demo patients, and ingest the committed example fixtures end-to-end
# through the new UploadController (which auto-confirms each extraction
# via ConfirmCommitter so the inbox shows committed rows on a fresh
# deploy). Authentication is the AGENTFORGE_ADMIN_TOKEN shared secret.
#
# Usage:
#   OPENEMR_BASE_URL=https://my-demo.up.railway.app \
#   AGENTFORGE_ADMIN_TOKEN=$TOKEN \
#   contrib/agentforge/refresh-demo.sh
#
#   # Tear-down only — drop demo patients without re-seeding.
#   OPENEMR_BASE_URL=... AGENTFORGE_ADMIN_TOKEN=... \
#   contrib/agentforge/refresh-demo.sh --reset-only
#
# Exits non-zero on missing env, HTTP failure, or non-ok server response.
#
# License: GPL-3.0  https://github.com/openemr/openemr/blob/master/LICENSE

set -euo pipefail

usage() {
    cat <<'EOF' >&2
usage: refresh-demo.sh [--reset-only] [--help]

Required environment variables:
  OPENEMR_BASE_URL       e.g. https://my-demo.up.railway.app
  AGENTFORGE_ADMIN_TOKEN must match the AGENTFORGE_ADMIN_TOKEN env var on
                         the OpenEMR service. When that var is unset on
                         the server, the endpoint returns 404 (the reset
                         flow is intentionally disabled by default).

Options:
  --reset-only           Drop demo patients without re-seeding.
  --help                 Show this message.
EOF
}

reset_only=0
for arg in "$@"; do
    case "$arg" in
        --reset-only)
            reset_only=1
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        *)
            echo "refresh-demo.sh: unknown argument: $arg" >&2
            usage
            exit 2
            ;;
    esac
done

: "${OPENEMR_BASE_URL:?OPENEMR_BASE_URL must be set (e.g. https://my-demo.up.railway.app)}"
: "${AGENTFORGE_ADMIN_TOKEN:?AGENTFORGE_ADMIN_TOKEN must be set; matches the env var on the OpenEMR service}"

# Strip any trailing slash to keep URL composition clean.
base_url="${OPENEMR_BASE_URL%/}"
endpoint="$base_url/interface/agentforge/admin/refresh.php"
if [[ "$reset_only" -eq 1 ]]; then
    endpoint="$endpoint?reset=1"
fi

echo "POST $endpoint" >&2

# -f → fail fast on HTTP >= 400 with a clear curl error.
# -S → keep the error message visible when -s is in effect.
# --max-time 600 → seeding can take ~3 minutes for the default 10-patient
# load, longer if OE_DEMO_SEED_LIMIT is bumped.
response=$(curl -sSf --max-time 600 -X POST \
    -H "X-AgentForge-Admin-Token: $AGENTFORGE_ADMIN_TOKEN" \
    -H 'Content-Length: 0' \
    "$endpoint")

# The endpoint always returns JSON. We do not require jq — keep this
# wrapper portable to bare Railway shells and Alpine containers.
echo "$response"
case "$response" in
    *'"status":"ok"'*|*'"status": "ok"'*)
        ;;
    *)
        echo "refresh-demo.sh: server did not return status=ok" >&2
        exit 1
        ;;
esac
