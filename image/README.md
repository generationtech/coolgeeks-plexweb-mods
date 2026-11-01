# plexweb-mods derived image

For Plex containers that cannot be changed in place: a read-only root
filesystem (`--read-only`), or a container that is recreated from its image
on every start (`--rm`). The mods are applied once, at build time, to a new
image derived from yours:

```
FROM <your Plex image> AS plex
FROM <Node image, pinned by digest> AS patch   # throwaway
    copy Plex's Resources/ in, run the injector (anchor preflight first),
    keep only index.html + plexweb-mods.js
FROM plex
    + one layer with those two files
```

- **Preflight gates the build.** If a required anchor does not resolve in
  this Plex Web (e.g. after a PMS update), the injector exits 3 and the build
  fails. The image you run is untouched; keep running it.
- **Nothing else changes.** User, entrypoint, command, ports, volumes and
  every other file come from your image. Node never reaches the result.
  The `RUN` step has no network (`--network none`).
- **Rollback** = run the plain image again (`--tag` must differ from
  `--plex-image`, so the plain one is kept).

## Build context

`npm run build` writes this directory to `dist/image/`: `Containerfile`,
`apply-in-build.sh`, `build-image.sh`, `injector.cjs`, `plexweb-mods.js`,
`VERSION`, `SHA256SUMS`, this file. Copy it to the host that holds your Plex
image; `build-image.sh` checks `SHA256SUMS` before building.

## Build

```sh
cd <copied dist/image>
./build-image.sh \
  --plex-image localhost/plex:1.2.3.4-abcdef012 \
  --node-image docker.io/library/node:22-bookworm-slim@sha256:<64 hex> \
  --tag localhost/plex-mods:1.2.3.4-abcdef012
# optional: --opt pfh-companion=off (repeatable), --no-banner, --engine docker
```

Use a Debian-based Node image (the script uses GNU `cp --parents`). Get a
digest with `podman pull <image>` then
`podman image inspect --format '{{.Digest}}' <image>`.

Expected output ends with the injector's anchor report, `plexweb-mods: image
layer (sha256):` listing the two files, and `build-image: built <tag>`.
Then point your container definition at the new tag and restart it. The
label `io.github.generationtech.plexweb-mods.version` records the mods
version and runtime hash; the served `index.html` references
`plexweb-mods.js?v=<runtime hash>`.

After every Plex image update, rebuild from the new Plex image. The
anchors are checked against the new Plex Web automatically.
