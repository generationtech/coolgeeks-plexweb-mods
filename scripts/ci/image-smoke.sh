#!/bin/sh
# Smoke test for the derived image (image/), run by CI: builds it for real
# with podman against two synthetic "Plex" base images made from the test
# fixtures (no Plex code): one whose Plex Web passes the anchor preflight,
# one that must fail the build. Checks what the result contains.
# Needs podman >= 4, a built dist/ (npm run build), and network for one pull
# of the Node image. Uses only localhost/plexweb-mods-ci/* image names.
set -eu
export LC_ALL=C
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
CTX="$ROOT/dist/image"
WORK=$(mktemp -d)
NODE_REF=${NODE_REF:-docker.io/library/node:22-bookworm-slim}
WEB=usr/lib/plexmediaserver/Resources/Plug-ins-ci/WebClient.bundle/Contents/Resources
IMG=localhost/plexweb-mods-ci
fail() { echo "image-smoke: FAIL: $*" >&2; exit 1; }
inspect() { podman image inspect --format "$2" "$1"; }
files() { # files <image> -> sorted file list of the image's filesystem
  c=$(podman create "$1" /none)
  podman export "$c" | tar -tf - | sed 's#^\./##' | grep -v '/$' | sort
  podman rm -f "$c" >/dev/null
}

[ -f "$CTX/build-image.sh" ] || fail "no $CTX; run npm run build first"
podman --version

# Synthetic Plex bases: the fixture as Plex Web, a non-root user and an
# entrypoint that the derived image must inherit unchanged.
for spec in pass:wp5-plex-shape fail:wp5; do
  tag=${spec%%:*} fixture=${spec#*:}
  dir="$WORK/base-$tag"
  mkdir -p "$dir/root/$WEB"
  cp -R "$ROOT/test/fixtures/bundles/$fixture/." "$dir/root/$WEB/"
  chmod -R u=rwX,go=rX "$dir/root"
  printf '%s\n' 'FROM scratch' 'COPY root/ /' 'USER 32400:32400' 'ENTRYPOINT ["/plex-entrypoint"]' > "$dir/Containerfile"
  podman build -q -t "$IMG/plex:$tag" "$dir" >/dev/null
done

podman pull -q "$NODE_REF" >/dev/null
digest=$(inspect "$NODE_REF" '{{.Digest}}')
node_pinned="${NODE_REF%:*}@$digest"
echo "image-smoke: node image $node_pinned"

# 1. A Plex Web that passes preflight: the build succeeds and adds one layer
#    holding exactly the patched index.html and the runtime.
"$CTX/build-image.sh" --plex-image "$IMG/plex:pass" --node-image "$node_pinned" --tag "$IMG/plex-mods:pass" --opt pfh-companion=off

[ "$(inspect "$IMG/plex-mods:pass" '{{len .RootFS.Layers}}')" -eq "$(($(inspect "$IMG/plex:pass" '{{len .RootFS.Layers}}') + 1))" ] ||
  fail "expected exactly one layer on top of the Plex image"
for f in '{{.Config.User}}' '{{json .Config.Entrypoint}}' '{{json .Config.Cmd}}'; do
  [ "$(inspect "$IMG/plex-mods:pass" "$f")" = "$(inspect "$IMG/plex:pass" "$f")" ] || fail "$f differs from the Plex image"
done
label() { inspect "$IMG/plex-mods:pass" "{{index .Labels \"$1\"}}"; }
[ "$(label io.github.generationtech.plexweb-mods.version)" = "$(cat "$CTX/VERSION")" ] || fail "version label is '$(label io.github.generationtech.plexweb-mods.version)'"
[ "$(label org.opencontainers.image.revision)" = "$(cat "$CTX/REVISION")" ] || fail "revision label is '$(label org.opencontainers.image.revision)'"
[ "$(label org.opencontainers.image.base.name)" = "$IMG/plex:pass" ] || fail "base.name label is '$(label org.opencontainers.image.base.name)'"
[ "$(label org.opencontainers.image.base.digest)" = "$(inspect "$IMG/plex:pass" '{{.Digest}}')" ] || fail "base.digest label is '$(label org.opencontainers.image.base.digest)'"
[ "$(label io.github.generationtech.plexweb-mods.base.id)" = "sha256:$(inspect "$IMG/plex:pass" '{{.Id}}' | sed 's/^sha256://')" ] || fail "base.id label is '$(label io.github.generationtech.plexweb-mods.base.id)'"
echo "image-smoke: labels OK (revision $(label org.opencontainers.image.revision), base $(label org.opencontainers.image.base.digest))"

files "$IMG/plex:pass" > "$WORK/base.list"
files "$IMG/plex-mods:pass" > "$WORK/derived.list"
added=$(comm -13 "$WORK/base.list" "$WORK/derived.list")
[ "$added" = "$WEB/plexweb-mods.js" ] || fail "files added to the Plex image: $added"
[ -z "$(comm -23 "$WORK/base.list" "$WORK/derived.list")" ] || fail "files went missing from the Plex image"
c=$(podman create "$IMG/plex-mods:pass" /none)
podman export "$c" | tar -xf - -C "$WORK" --wildcards "*$WEB/index.html" "*$WEB/plexweb-mods.js"
podman rm -f "$c" >/dev/null
grep -q "plexweb-mods.js?v=$(sed -n 's/.*runtime=//p' "$CTX/VERSION")\"" "$WORK/$WEB/index.html" || fail "index.html lacks the runtime tag"
grep -q 'data-opt-pfh-companion="off"' "$WORK/$WEB/index.html" || fail "index.html lacks the --opt value"
cmp -s "$WORK/$WEB/plexweb-mods.js" "$CTX/plexweb-mods.js" || fail "runtime in the image differs from the build"
echo "image-smoke: pass case OK (one layer, two files, config inherited, no Node)"

# 2. A Plex Web that fails preflight: the build must fail and tag nothing.
if "$CTX/build-image.sh" --plex-image "$IMG/plex:fail" --node-image "$node_pinned" --tag "$IMG/plex-mods:fail" > "$WORK/fail.log" 2>&1; then
  cat "$WORK/fail.log"
  fail "the build succeeded although preflight must fail"
fi
grep -q 'preflight failed; not applying' "$WORK/fail.log" || { cat "$WORK/fail.log"; fail "the failed build did not show the preflight failure"; }
grep -q "keep running your current image" "$WORK/fail.log" || fail "no operator hint after the failed build"
! podman image exists "$IMG/plex-mods:fail" || fail "a failed build left a tagged image"
echo "image-smoke: fail case OK (preflight failure fails the build, nothing tagged)"
