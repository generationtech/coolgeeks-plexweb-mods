#!/bin/sh
# Builds a derived Plex image with plexweb-mods applied (README.md next to it).
# Run it inside the build context that `npm run build` writes to dist/image/,
# on the host that holds your Plex image, as the user that owns that image
# (root for a rootful Podman unit). Needs podman (or docker) and sha256sum.
#
#   ./build-image.sh --plex-image REF --node-image NAME@sha256:DIGEST --tag REF \
#                    [--opt key=value]... [--no-banner] [--engine podman|docker]
#
# Exit codes: 0 built; 1 failed (a failed anchor preflight fails the build);
# 2 usage. Nothing is started, and the Plex image itself is never changed.
set -eu
cd "$(dirname "$0")"

USAGE="usage: ./build-image.sh --plex-image REF --node-image NAME@sha256:DIGEST --tag REF [--opt key=value]... [--no-banner] [--engine podman|docker]"
die() { echo "build-image: $*" >&2; exit 1; }
bad() { echo "build-image: $*" >&2; echo "$USAGE" >&2; exit 2; }
ref_ok() { printf '%s' "$1" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._/:@-]*$'; }

engine=podman
plex_image=
node_image=
tag=
mods_args=
while [ $# -gt 0 ]; do
  case "$1" in
    --plex-image | --node-image | --tag | --engine | --opt)
      [ $# -ge 2 ] || bad "$1 needs a value"
      case "$1" in
        --plex-image) plex_image=$2 ;;
        --node-image) node_image=$2 ;;
        --tag) tag=$2 ;;
        --engine) engine=$2 ;;
        --opt)
          printf '%s' "$2" | grep -Eq '^[a-z0-9-]+=[A-Za-z0-9._,:-]*$' ||
            bad "--opt expects key=value (key: a-z 0-9 -; value: A-Z a-z 0-9 . _ , : -), got: $2"
          mods_args="$mods_args --opt $2"
          ;;
      esac
      shift 2
      ;;
    --no-banner) mods_args="$mods_args --no-banner"; shift ;;
    -h | --help) echo "$USAGE"; exit 0 ;;
    *) bad "unknown argument: $1" ;;
  esac
done
case "$engine" in podman | docker) ;; *) bad "--engine must be podman or docker" ;; esac
[ -n "$plex_image" ] && ref_ok "$plex_image" || bad "--plex-image is required (an image reference)"
[ -n "$tag" ] && ref_ok "$tag" || bad "--tag is required (an image reference)"
[ "$tag" != "$plex_image" ] || bad "--tag must differ from --plex-image: keep the plain image for rollback"
printf '%s' "$node_image" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._/:-]*@sha256:[0-9a-f]{64}$' ||
  bad "--node-image must be pinned by digest (NAME@sha256:<64 hex>)"

sha256sum -c --quiet SHA256SUMS || die "this build context does not match its SHA256SUMS (incomplete copy, or changed?)"
"$engine" image inspect "$plex_image" >/dev/null 2>&1 || die "Plex image $plex_image not found ($engine image inspect)"
version=$(cat VERSION)

echo "build-image: $plex_image + plexweb-mods $version -> $tag"
# No network for RUN steps: the patch stage only reads and writes files.
"$engine" build --network none \
  --build-arg PLEX_IMAGE="$plex_image" \
  --build-arg NODE_IMAGE="$node_image" \
  --build-arg MODS_ARGS="${mods_args# }" \
  --build-arg MODS_VERSION="$version" \
  -f Containerfile -t "$tag" . ||
  die "build failed (exit $?). If the log above says 'preflight failed', this Plex Web breaks a required anchor: keep running your current image."
echo "build-image: built $tag"
