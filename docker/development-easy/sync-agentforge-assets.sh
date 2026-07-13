#!/usr/bin/env bash
# Push agentforge assets into the running OpenEMR container.
#
# OpenEMR's docker-compose mounts a named volume (assetvolume) on
# public/assets, which masks the host bind-mount for that subtree.
# Edits to public/assets/agentforge/* on the host therefore don't show
# up inside the container automatically. This script syncs them.
#
# Run from this directory: ./sync-agentforge-assets.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONTAINER="development-easy-openemr-1"

echo "Syncing agentforge assets from $REPO_ROOT/public/assets/agentforge/ → $CONTAINER ..."
for file in "$REPO_ROOT"/public/assets/agentforge/*; do
  name="$(basename "$file")"
  docker cp "$file" "$CONTAINER:/var/www/localhost/htdocs/openemr/public/assets/agentforge/$name"
  echo "  ✓ $name"
done
echo "Done. Hard-refresh the browser (Ctrl+Shift+R) to pick up the new bundle."
