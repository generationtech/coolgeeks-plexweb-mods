#!/bin/sh
# Installs a pinned gitleaks release into $1 (default: ./.bin), verifying the
# release checksum. Used by CI on GitHub-hosted runners.
set -eu
VERSION="${GITLEAKS_VERSION:-8.30.1}"
DEST="${1:-.bin}"
TARBALL="gitleaks_${VERSION}_linux_x64.tar.gz"
BASE="https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}"
TMP="$(mktemp -d)"
curl -sSfL -o "$TMP/$TARBALL" "$BASE/$TARBALL"
curl -sSfL -o "$TMP/checksums.txt" "$BASE/gitleaks_${VERSION}_checksums.txt"
(cd "$TMP" && grep " ${TARBALL}\$" checksums.txt | sha256sum -c -)
mkdir -p "$DEST"
tar -xzf "$TMP/$TARBALL" -C "$DEST" gitleaks
"$DEST/gitleaks" version
