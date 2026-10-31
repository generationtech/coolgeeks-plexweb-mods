#!/bin/sh
# Re-apply plexweb-mods to the Plex Web copy served by Plex Media Server.
# Run after every PMS update. Thin wrapper: loads ./.env, builds dist/ if
# needed, then runs the Node injector (dist/injector.cjs) with your args.
#
#   ./injector/reapply.sh --dry-run     # see what would change
#   ./injector/reapply.sh               # apply (idempotent, preflight-gated)
#   ./injector/reapply.sh --uninstall   # remove
#   ./injector/reapply.sh --status
#
# Linux package installs usually need root to write the Plex Web dir:
#   sudo env "PATH=$PATH" ./injector/reapply.sh
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ -f "$ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env"
  set +a
fi

if ! command -v node >/dev/null 2>&1; then
  echo "reapply: node (>= 22) is required on this machine" >&2
  exit 1
fi

if [ ! -f "$ROOT/dist/injector.cjs" ] || [ ! -f "$ROOT/dist/plexweb-mods.js" ]; then
  echo "reapply: dist/ not built; building..." >&2
  (cd "$ROOT" && npm run --silent build) >&2
fi

exec node "$ROOT/dist/injector.cjs" "$@"
