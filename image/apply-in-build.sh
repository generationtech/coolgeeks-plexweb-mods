#!/bin/sh
# Runs in image/Containerfile's patch stage (a Node image). Applies the mods
# to the Plex Web copy taken from the Plex image, gated by the injector's own
# preflight (exit 3 = a required anchor failed, which fails the build), then
# lays out under $OUT exactly the two files that change, at their absolute
# paths, with parent directory attributes copied from the Plex image.
# Arguments: extra injector flags (--opt key=value, --no-banner).
# PLEX_ROOT, MODS_DIR and OUT are only overridden by the unit tests.
set -eu
PLEX_ROOT="${PLEX_ROOT:-/}"
PLEX_ROOT="${PLEX_ROOT%/}"
MODS_DIR="${MODS_DIR:-/plexweb-mods}"
OUT="${OUT:-/out}"
case "$OUT" in /*) ;; *) OUT="$(pwd)/$OUT" ;; esac

search="$PLEX_ROOT/usr/lib/plexmediaserver"
found=$(find "$search" -type f -path '*/WebClient.bundle/Contents/Resources/index.html' 2>/dev/null || true)
n=$(printf '%s' "$found" | grep -c '' || true)
if [ "$n" -ne 1 ]; then
  echo "plexweb-mods: expected exactly one Plex Web index.html under $search, found $n" >&2
  if [ -n "$found" ]; then printf '%s\n' "$found" >&2; fi
  exit 1
fi
web=$(dirname "$found")

node "$MODS_DIR/injector.cjs" --install-type linux --web-dir "$web" --runtime "$MODS_DIR/plexweb-mods.js" "$@"

rel=${web#"$PLEX_ROOT"/}
mkdir -p "$OUT"
(cd "$PLEX_ROOT/" && cp -p --parents "$rel/index.html" "$rel/plexweb-mods.js" "$OUT/")
echo "plexweb-mods: image layer (sha256):"
(cd "$OUT" && find . -type f -exec sha256sum {} +)
