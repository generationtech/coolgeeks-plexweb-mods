# BACKLOG

Work that needs the owner's real Plex server or homelab, plus designed but
unbuilt automation. Each item has exact commands and the expected result,
so a future session (or the owner) can run it without asking questions.

Already done without the homelab (see `docs/anchor-research.md`): anchor
research on Plex Web 4.162.1 (PMS 1.43.5 package) and 4.163.0
(app.plex.tv); an offline preflight of Plex Web 4.160.0 (PMS 1.43.4.10903
package): green; both native-player paths (primary and fallback); the
playQueue curl test. The e2e suite is green against a throwaway unclaimed
PMS (`scripts/sandbox-pms.sh`), locally and in CI on every push. It covers
grid, Detail/Table View, TV season, Other Videos, 300-item windowing with
Next/Previous and with unpaused autoplay, and a check that the companion
fallback cannot reach Plex Web (only a claimed server is left to try, B4).
The derived image (`image/`) is built for real by CI with podman against
synthetic Plex bases (`scripts/ci/image-smoke.sh`).

**The target setup** for B1–B6: Plex Media Server in a hardened container
run by a systemd unit on a separate container host: rootful Podman,
**read-only root filesystem**, `--rm` (a fresh container from the image on
every start), image built locally from the official PMS `.deb`, clients
connecting straight to PMS on :32400 over HTTPS (`*.plex.direct`, "Secure
connections: Required"), no reverse proxy. Such a container can't be
changed in place (the injector refuses it), so the mods ship as a
**derived image** (`image/`). Other installs: see the notes in B1.

Conventions:

- Run everything from the repo root on your **workstation**. Commands for
  the container host go through `ssh "$PLEX_SSH"` (the user that owns the
  Plex image; root for a rootful unit). Nothing needs Node on that host.
- `$VARS` come from your local `.env` (copy `.env.example`; never commit
  `.env`). Load it into your shell first: `set -a; . ./.env; set +a`
- Owner-specific notes (real hostnames, paths, image names) belong in the
  gitignored `local/`, never in this file.
- Record results in `docs/anchor-research.md` (findings log) using
  placeholders for ids, hostnames and library names. Anchor strings only.
- Order: B0 → B1 → B2 → B3 → B4 → B5. B6–B12 are optional.
- **Merge plan (owner, 2026-11-01):** after B5 passes, the owner
  squash-merges `claude/plex-play-from-here-rzg61g` into `main` and deletes
  the branch. No history rewrite before that; sessions keep pushing to the
  branch (never force-push).

---

## B0. One-time setup on the workstation

```sh
git clone https://github.com/generationtech/coolgeeks-plexweb-mods && cd coolgeeks-plexweb-mods
git checkout claude/plex-play-from-here-rzg61g   # until it is merged
node --version          # expect v22.12 or newer (nvm is fine)
./scripts/ci/install-gitleaks.sh ~/.local/bin && gitleaks version   # if gitleaks is missing; expect 8.30.1
npm ci                  # also installs the pre-commit hook (gitleaks, lint, tests)
npm test                # expect: all tests pass, 0 failed
npm run build           # expect: dist/plexweb-mods.js, dist/injector.cjs, dist/preflight.cjs, dist/fetch-plex-web.cjs, dist/image/
cp .env.example .env    # then fill in as B1–B5 describe
git check-ignore -v .env local/x    # expect both ignored
```

Expected: the build succeeds, and `git status` lists neither `.env` nor
`local/`. The hook loads `~/.nvm/nvm.sh` itself when a GUI git client runs
it without Node 22 on PATH, and refuses any file under `local/`, even
force-added. Optional rehearsal with no server and no account:
`scripts/sandbox-pms.sh start`, then B4 against the env it prints.

## B1. Look at the Plex container (read-only)

On the container host (through ssh), then over HTTP from the workstation:

```sh
ssh "$PLEX_SSH" "podman ps --format '{{.Names}}  {{.Image}}'"
ssh "$PLEX_SSH" "podman inspect --format 'image={{.ImageName}} readonly={{.HostConfig.ReadonlyRootfs}} rm={{.HostConfig.AutoRemove}} user={{.Config.User}}' '$PLEX_CONTAINER'"
ssh "$PLEX_SSH" "podman exec '$PLEX_CONTAINER' find /usr/lib/plexmediaserver -path '*WebClient.bundle/Contents/Resources/index.html'"
ssh "$PLEX_SSH" "systemctl cat '$PLEX_UNIT' | grep -n -E 'podman run|--read-only|--rm|image|localhost/'"
```

Expected: one container (its name goes into `.env` as `PLEX_CONTAINER`
before the next two commands); `readonly=true rm=true`; exactly one path,
`/usr/lib/plexmediaserver/Resources/Plug-ins-<build>/WebClient.bundle/Contents/Resources/index.html`;
the unit's `podman run` line ends with the image reference. Put the
`image=` value in `.env` as `PLEX_IMAGE`, the unit name as `PLEX_UNIT`,
and choose `PLEX_MODS_IMAGE` (same name plus `-mods`, same tag) and
`PLEX_MODS_BUILD_DIR` (any root-only directory outside your Plex data).

`PLEX_URL`: with "Secure connections: Required" it must be the server's
`https://<ip-with-dashes>.<server-hash>.plex.direct:32400` name. The
`<server-hash>` is in the certificate PMS presents:

```sh
openssl s_client -connect <plex-ip>:32400 </dev/null 2>/dev/null | openssl x509 -noout -ext subjectAltName
# DNS:*.<server-hash>.plex.direct  ->  PLEX_URL=https://<a-b-c-d>.<server-hash>.plex.direct:32400
curl -sSI "$PLEX_URL/web/index.html" | grep -i -E '^(HTTP|content-security-policy|cache-control)'
```

Expected: `HTTP/1.1 200 OK`, `Cache-Control: no-cache`, and **no**
`Content-Security-Policy` line. If a proxy or PMS ever adds one, the
runtime needs `script-src 'self' 'unsafe-eval'` (no inline script). The
`*.plex.direct` name must resolve on your LAN (a DNS rebinding exception
for `plex.direct`); gitleaks blocks these names in commits, so keep them
in `.env`.

**If curl says `SSL certificate problem: unable to get local issuer
certificate`**, your workstation does not trust the root at the top of the
server's certificate chain, although browsers do. Seen 2026-11-01: the
plex.direct certificate is issued by Let's Encrypt `YR2`, which chains to
the new `ISRG Root YR`; neither Ubuntu 22.04's `ca-certificates`
20260601 nor Node 22's built-in list had it yet. Nothing is wrong on the
server. For now, skip verification: add `-k` to the curl commands in
B1, B2 and B4, set `PLEX_E2E_IGNORE_TLS=1` in `.env` (the e2e's browser
and API calls), and run `--verify-served` (B5) with
`NODE_TLS_REJECT_UNAUTHORIZED=0` in front. B12 restores verification.

Other installs: a **writable** container (`readonly=false`, no `--rm`)
can use the injector in place (`PLEX_INSTALL_TYPE=podman` or `docker`,
`PLEX_CONTAINER=<name>`, run on the container host with Node 22). A Linux
**package** install uses `PLEX_INSTALL_TYPE=linux` on the server
(`sudo env "PATH=$PATH" ./injector/reapply.sh --status`, expect
`index.html: pristine`). The rest of this file follows the read-only
container.

## B2. PMS version: is an update needed first?

```sh
curl -sS -H 'Accept: application/json' "$PLEX_URL/identity" | node -pe 'JSON.parse(require("fs").readFileSync(0)).MediaContainer.version'
```

Expected: `1.43.4.10903-e5521bd8c` or later. Preflight is green (offline)
on the Plex Web bundled with 1.43.4.10903 (4.160.0) and 1.43.5.11079
(4.162.1); the mod is live-verified on 4.162.1 only. Older than 1.43.4:
update first. Otherwise no update is needed to try it; B4 proves it live.
For an image built from a pinned `.deb`, updating means: new pins, rebuild
the Plex image, then rebuild the mods image (B6).

## B3. Preflight your exact Plex Web, offline

Put the package version and SHA-1 your image is built from into `.env`
(`PLEX_VERSION`, `PLEX_DEB_SHA1`; plex.tv publishes the SHA-1), then:

```sh
D="bundle-snapshots/pms-$PLEX_VERSION"     # gitignored
mkdir -p "$D" && curl -fsS --proto '=https' -o "$D/pms.deb" \
  "https://downloads.plex.tv/plex-media-server-new/$PLEX_VERSION/debian/plexmediaserver_${PLEX_VERSION}_amd64.deb"
echo "$PLEX_DEB_SHA1  $D/pms.deb" | sha1sum -c -
mkdir "$D/root" && dpkg-deb -x "$D/pms.deb" "$D/root"
W=$(dirname "$(find "$D/root" -path '*WebClient.bundle/Contents/Resources/index.html')")
ls "$W/js" | grep -o 'plex-[0-9.]*-[0-9a-f]*' | sort -u     # Plex Web version
node dist/preflight.cjs --bundle-dir "$W"
```

Expected: `pms.deb: OK`, one Plex Web version, `chunk globals:
webpackChunkplex_web_client`, `group play-from-here/player: active =
play-from-here/native-player; standby = play-from-here/native-player-fallback`
and `RESULT: all required anchors resolved`. Done for 1.43.4.10903
(4.160.0) on 2026-11-01. For an image not built from the `.deb`, snapshot
it instead (read-only, throwaway container, no network):
`mkdir -p bundle-snapshots/image && ssh "$PLEX_SSH" "podman run --rm --network none --entrypoint tar '$PLEX_IMAGE' -C <web dir from B1> -cf - ." | tar -xf - -C bundle-snapshots/image`,
then the same `node dist/preflight.cjs --bundle-dir bundle-snapshots/image`.
If preflight fails, the report names the anchor and why. Fix
`patches/play-from-here/plex-anchors.ts` following the method in
`docs/anchor-research.md` (`--find` lists module ids, never code). If only
the primary player anchor breaks, the group line shows the fallback as
active and playback keeps working.

## B4. Live e2e against your server, server untouched (token auth)

Route mode injects the local build into the test browser by request
interception: this proves the mod live on your Plex Web without changing
the server. A claimed server needs a token, which the e2e puts into
browser storage (`e2e/auth.ts`, key `myPlexAccessToken`, the one remaining
unverified e2e assumption).

```sh
curl -sS -o /dev/null -w '%{http_code}\n' -H "X-Plex-Token: $PLEX_TOKEN" "$PLEX_URL/library/sections"   # expect 200
curl -sS -H 'Accept: application/json' -H "X-Plex-Token: $PLEX_TOKEN" "$PLEX_URL/library/sections" \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).MediaContainer.Directory.map(d=>d.key+" "+d.type).join("\n")'   # ids + types, for .env
npx playwright install chromium        # once; add --with-deps (sudo) if Chromium lacks system libraries
npm run build && npx playwright test
```

Certificate errors: see the note at the end of B1 (`-k`,
`PLEX_E2E_IGNORE_TLS=1`).

Get the token from a signed-in Plex Web (open any item, "..." > Get Info >
View XML: the opened URL ends in `X-Plex-Token=<token>`; or DevTools >
Network, any request to the server), into `.env` only, never into a chat
or a shell history: `read -rs T && sed -i "s/^PLEX_TOKEN=.*/PLEX_TOKEN=$T/" .env && unset T`.
It is your account's token: treat it like a password (signing out all
devices on plex.tv revokes it). Set `PLEX_SECTION_ID` to a movie library id. Expected: **4 passed** (grid, Detail View, Table View,
and the companion check), the rest skipped unless you set
`PLEX_E2E_TV_SECTION_ID`, `PLEX_E2E_OTHER_SECTION_ID`,
`PLEX_E2E_BIG_SECTION_ID` (a library with 100+ items). The companion test
answers the last open question on a claimed server: it expects PMS to
answer 404 to `playMedia` aimed at Plex Web. If it passes, also remove the
companion path (or default `pfh-companion` to `off`) and note it in
`docs/anchor-research.md`; if it fails because playback *started*, promote
`api.companionPlayMedia` to verified with the versions. If the run shows a
sign-in screen, find the key(s) holding the token in a signed-in browser
(DevTools > Application > Local Storage for `$PLEX_URL`), put them in
`TOKEN_STORAGE_KEYS` in `e2e/auth.ts`, and promote the note there to
verified. Set `PLEX_E2E_SORT_LABEL` to a sort your library offers (default
`Year`). Debug with `PW_TRACE=1` (traces and screenshots can contain the
token and library names: keep them local, they are gitignored). The tests
start real playback: it shows up in PMS's log like any playback by your
account, and an item played for a few seconds may get a resume point
("Continue Watching"; remove it from the item's "..." menu). **Leave
`PLEX_E2E_BIG_SECTION_ID` unset on a real server:** its autoplay test waits
for Plex to play about a dozen items through by itself, which only works
with the sandbox's 2-second clips. Before pasting output anywhere, redact
the token, the plex.direct hash and 40-hex ids:
`sed -E "s/[0-9a-f]{32}\.plex\.direct/<hash>.plex.direct/g; s/\b[0-9a-f]{40}\b/<id40>/g; s/${PLEX_TOKEN:-no-token-set}/<token>/g"`.

## B5. First real deploy: the derived image

1. Pin the Node image for the throwaway build stage (once, on the host):

   ```sh
   ssh "$PLEX_SSH" "podman pull -q docker.io/library/node:22-bookworm-slim >/dev/null && podman image inspect --format '{{.Digest}}' docker.io/library/node:22-bookworm-slim"
   ```

   Put `NODE_IMAGE=docker.io/library/node@<that digest>` in `.env`. The
   same value without touching the host, from the workstation (Docker Hub's
   public registry API; prints the linux/amd64 image of the tag's index):

   ```sh
   T=$(curl -fsS "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/node:pull" | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
   curl -fsS -H "Authorization: Bearer $T" -H 'Accept: application/vnd.oci.image.index.v1+json' \
     https://registry-1.docker.io/v2/library/node/manifests/22-bookworm-slim \
     | node -pe 'JSON.parse(require("fs").readFileSync(0)).manifests.find(m=>m.platform.os==="linux"&&m.platform.architecture==="amd64").digest'
   ```

2. Stage the build context on the host:

   ```sh
   npm run build
   ssh "$PLEX_SSH" "install -d -m 0750 '$PLEX_MODS_BUILD_DIR'"
   rsync -rlpt --delete dist/image/ "$PLEX_SSH:$PLEX_MODS_BUILD_DIR/"
   ssh "$PLEX_SSH" "cd '$PLEX_MODS_BUILD_DIR' && sha256sum -c --quiet SHA256SUMS && cat VERSION"
   ```

   Expected: only the VERSION line (`<mods version> runtime=<12 hex>`).
   Build from a clean, pushed commit: `cat dist/image/REVISION` must be a
   40-hex SHA without `-dirty`.

3. Build. This starts nothing and leaves `$PLEX_IMAGE` untouched:

   ```sh
   ssh "$PLEX_SSH" "cd '$PLEX_MODS_BUILD_DIR' && ./build-image.sh --plex-image '$PLEX_IMAGE' --node-image '$NODE_IMAGE' --tag '$PLEX_MODS_IMAGE'"
   ssh "$PLEX_SSH" "podman image inspect --format '{{json .Labels}}' '$PLEX_MODS_IMAGE'"
   ssh "$PLEX_SSH" "podman image inspect --format '{{.Digest}}' '$PLEX_IMAGE'"
   ```

   Expected: the anchor report with `RESULT: all required anchors
   resolved`, `plexweb-mods: image layer (sha256):` listing exactly
   `index.html` and `plexweb-mods.js`, `build-image: built <tag>`. The
   labels: `org.opencontainers.image.revision` = `dist/image/REVISION`,
   `org.opencontainers.image.base.name` = `$PLEX_IMAGE`,
   `org.opencontainers.image.base.digest` = the digest the last command
   prints, and `io.github.generationtech.plexweb-mods.version` =
   `dist/image/VERSION`. Record the mods image's own digest
   (`podman image inspect --format '{{.Digest}}' '$PLEX_MODS_IMAGE'`) where
   you record deployments. If it says `preflight failed`, nothing changed:
   go to B3.

4. Switch the unit to the derived image. In the unit's source of truth,
   change **only** the image reference from `$PLEX_IMAGE` to
   `$PLEX_MODS_IMAGE` (every other flag stays: read-only, user, caps,
   mounts), deploy it the way you deploy that unit, then:

   ```sh
   ssh "$PLEX_SSH" "systemctl cat '$PLEX_UNIT' | grep -c '$PLEX_MODS_IMAGE'"   # expect 1
   ssh "$PLEX_SSH" "systemctl daemon-reload && systemctl restart '$PLEX_UNIT' && sleep 15 && systemctl is-active '$PLEX_UNIT'"
   ```

   Expected: `1`, then `active`. **Rollback:** put `$PLEX_IMAGE` back,
   `daemon-reload`, restart.

5. Verify from the workstation:

   ```sh
   ./injector/reapply.sh --verify-served
   PLEX_E2E_INJECT=server npx playwright test
   ```

   Certificate errors (B1 note): `NODE_TLS_REJECT_UNAUTHORIZED=0
   ./injector/reapply.sh --verify-served` (Node prints a warning), and
   keep `PLEX_E2E_IGNORE_TLS=1` for the e2e.

   Expected: `HTTP verify: index.html served with the new tag
   (Cache-Control: no-cache)`, `HTTP verify: runtime served and matches the
   build`, `the served Plex Web carries this build`; the e2e gives the same
   passes as B4 minus the companion test (route mode only). In a browser:
   hard-reload once (Ctrl+Shift+R), open a library's **Library** tab, sort
   it, open an item's "..." menu: "Play from here" sits under "Play Next"
   (also on a TV season page). In the DevTools console:

   ```js
   document.documentElement.dataset.plexwebModsStatus           // expect "ok"
   __plexwebMods.plugins["play-from-here"].activePath()        // expect { path: "native" }
   __plexwebMods.printReport({ final: true })
   ```

Optional: prove the fallback player on your Plex Web without a rebuild:
`PLEX_E2E_PLAYER=fallback npx playwright test` (route mode).

## B6. (optional) After every Plex update: rebuild the mods image

The mods live in the image, so a Plex update means: build the new Plex
image as usual, then B3 for the new version (optional: the build runs the
same preflight), then B5 steps 2–5 with the new `PLEX_IMAGE` and
`PLEX_MODS_IMAGE` tags in `.env`. If the mods build fails on preflight,
nothing changed; choose between running the new plain Plex image (mods
off until the anchors are fixed) and staying on the old mods image (old
PMS). Keep the previous plain and mods images until the new one has run
for a while (rollback).

Linux package installs instead re-apply in place after each PMS update
(idempotent; refuses if preflight fails, exit 3, Plex untouched), e.g. a
systemd path unit; the reapply's own write triggers one extra, no-op run:

```ini
# /etc/systemd/system/plexweb-mods.service
[Service]
Type=oneshot
WorkingDirectory=/path/to/coolgeeks-plexweb-mods
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=/path/to/coolgeeks-plexweb-mods/injector/reapply.sh

# /etc/systemd/system/plexweb-mods.path
[Path]
PathChanged=<PLEX_WEB_DIR>/index.html
[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload && sudo systemctl enable --now plexweb-mods.path
journalctl -u plexweb-mods.service -n 50    # after the next PMS update: expect "applied" or "already applied"
```

A writable Docker/Podman container: run `./injector/reapply.sh` after every
container (re)start.

## B7. (optional) Docker: confirm the injector path inside the official image

The injector's Docker mode is tested against an emulated container only.
With a writable Docker install of the official image, B1's checks (with
`docker` for `podman`) and an in-place `./injector/reapply.sh --status`
(`PLEX_INSTALL_TYPE=docker`) exercise it for real; if
`docker exec <container> find /usr/lib/plexmediaserver -path '*WebClient.bundle/Contents/Resources/index.html'`
prints nothing, set `PLEX_WEB_DIR` and add the path to `DEFAULT_SEARCH_ROOTS`
in `injector/target-fs.ts` (with a test).

## B8. (optional, design ready) Weekly breakage canary

Goal: catch a PMS or Plex Web release that breaks an anchor **before** you
install it at home. Today CI runs the sandbox e2e on every push, but only
against whatever release is current at push time, and nothing runs when
the repo is idle.

Design (build it as `.github/workflows/canary.yml`; GitHub-hosted runners, no secrets):

- **Schedule:** `on: { schedule: [{ cron: "17 6 * * 1" }], workflow_dispatch: {} }`
  (Mondays 06:17 UTC; off the hour to avoid the top-of-hour queue).
  `permissions: { contents: read, issues: write }`.
- **Version detection** (first step, also printed to the job summary):
  - PMS: `scripts/sandbox-pms.sh version` → `<version> <url> <sha1>` from
    `https://plex.tv/api/downloads/5.json` (public channel; Plex Pass betas
    need a token, so they are out of scope by design).
  - Bundled Plex Web: after extraction,
    `ls "$PLEX_WEB_DIR"/js | grep -o 'plex-[0-9.]*-[0-9a-f]*' | sort -u`.
  - Hosted Plex Web: `curl -sS https://app.plex.tv/desktop/index.html | grep -o 'plex-[0-9.]*-[0-9a-f]*' | sort -u`.
  - "New since last week": restore `canary-state/versions.json` with
    `actions/cache` (key `canary-state-${{ github.run_id }}`, restore-keys
    `canary-state-`), diff, and save the new file at the end; the diff only
    affects the report text, the checks always run.
- **Checks** (reuse, don't copy, the CI e2e job: move its steps into a
  composite action `.github/actions/sandbox-e2e/action.yml` used by both):
  1. `node dist/preflight.cjs --bundle-dir "$PLEX_WEB_DIR" --json > preflight-bundled.json`
     (exit 1 = anchor failure; the JSON holds anchor strings and module ids only);
  2. `node dist/fetch-plex-web.cjs --url https://app.plex.tv/desktop/ --out bundle-snapshots/app`
     then `node dist/preflight.cjs --bundle-dir bundle-snapshots/app --json > preflight-hosted.json`
     (initial chunks only, so lazy-chunk anchors may report unresolved there: treat
     the hosted run as a warning unless a group has NO MEMBER AVAILABLE);
  3. the sandbox e2e in the three modes, exactly as the CI job.
- **Cache keys:** PMS package `pms-deb-linux-x86_64-<version>` (the same key
  as the CI e2e job, so the canary warms CI's cache for the new release);
  Playwright browsers `~/.cache/ms-playwright` keyed
  `pw-${{ hashFiles('package-lock.json') }}`; canary state as above.
- **Reporting:** always write a job summary (versions, the preflight group
  lines, e2e pass/fail counts). On failure, `actions/github-script` (the
  built-in `GITHUB_TOKEN`, not a user secret) opens or updates one issue
  labelled `canary`, titled `Canary: PMS <version> / Plex Web <version> breaks play-from-here`,
  with the preflight text report (anchor strings only) and the failing test
  names; on the next green run it comments and closes that issue. Upload
  `preflight-*.json` as artifacts; never upload bundles, traces or
  screenshots. GitHub also emails the workflow's owner when a scheduled run
  fails.
- **Expected:** a green run takes about 10 minutes; a breaking release shows
  up as a `canary` issue naming the anchor and patch that failed (e.g.
  `group play-from-here/player: active = play-from-here/native-player-fallback; no standby available`
  means the primary broke but playback still works).

## B9. (optional) Self-hosted runner for e2e against the homelab, with fork-PR protections

Only if the sandbox e2e in CI is not enough (e.g. to test your real libraries). A
self-hosted runner on a public repo is risky; only like this:

1. Repo Settings > Actions > General: "Fork pull request workflows from
   outside collaborators" = **Require approval for all external
   contributors**; workflow permissions = read-only.
2. Settings > Environments > new environment `homelab` with **required
   reviewers** (the owner); add `PLEX_URL`, `PLEX_TOKEN`, `PLEX_SECTION_ID`
   as *environment* secrets.
3. A separate `.github/workflows/e2e.yml` triggered only by
   `workflow_dispatch` (never `pull_request` or `pull_request_target`),
   `runs-on: [self-hosted, plex-e2e]`, `environment: homelab`, running
   `npm ci && npm run build && npx playwright test`.
4. Runner: unprivileged user in a dedicated VM or container, no Docker
   socket, network limited to the PMS host, registered as ephemeral:
   `./config.sh --url https://github.com/generationtech/coolgeeks-plexweb-mods --token <token from Settings > Actions > Runners> --labels plex-e2e --ephemeral --unattended`

Expected: the e2e workflow runs only when dispatched manually and only
after approval; PRs from forks never reach the runner.

## B10. (optional) Hardening, no server needed

- Pin GitHub Actions to commit SHAs and pin the gitleaks tarball's sha256
  in `scripts/ci/install-gitleaks.sh` (today it checks the release's own
  checksums file).
- Localized UIs: `dom.menuAnchorLabels` holds English labels. Plex Web ships
  `translations/<lang>.json` (English source string → translation), so the
  runtime could load the active language's labels instead.

## B11. (optional) Find the flaky sandbox e2e step

Needs read access to the repo's Actions logs (anonymous API calls get 403
for job logs). In session 5 the CI e2e job failed twice with PMS
1.43.5.11079 unchanged, then passed: run `41325151719` on commit `0cb2dc9`
("e2e, runtime injected by interception (fallback player forced)") and run
`41329272814` on `81c309a` ("e2e against an injector-applied install");
the same injector calls pass locally against real Plex Web.

```sh
gh run view 41329272814 --log-failed | grep -E -B2 -A20 '✘|Error|Timeout|expect\('
gh run list --branch claude/plex-play-from-here-rzg61g --limit 20 --json conclusion,headSha,databaseId
```

Expected: the failing test name and its assertion or timeout. Fix the
wait or assertion in `e2e/` (likely a timing window, e.g. autoplay or the
player starting), then re-run the job a few times (`gh run rerun <id>
--job <job id>`) to confirm.


## B12. (optional) Trust the server's certificate chain on the workstation

Only when B1's certificate note applies. Workstation only; the server is
not touched. Goal: drop `-k`, `PLEX_E2E_IGNORE_TLS` and
`NODE_TLS_REJECT_UNAUTHORIZED` again, so the token only goes to a server
whose certificate checks out.

1. Maybe updates fixed it already (`sudo apt upgrade`, a newer Node 22):

   ```sh
   curl -sS -o /dev/null -w 'curl: %{http_code}\n' "$PLEX_URL/identity"
   node -e 'fetch(process.env.PLEX_URL + "/identity").then(r => console.log("node:", r.status), e => console.log("node:", e.cause?.code ?? e.message))'
   ```

   Both `200`: go to step 4.

2. Fetch the missing CA certificate from the URL named by the top of the
   chain (its "CA Issuers" entry), into the gitignored `local/`:

   ```sh
   mkdir -p local/tls
   openssl s_client -connect "${PLEX_URL#https://}" -showcerts </dev/null 2>/dev/null \
     | awk '/-----BEGIN CERTIFICATE-----/{p=1; c=""} p{c=c $0 "\n"} /-----END CERTIFICATE-----/{p=0; last=c} END{printf "%s", last}' > local/tls/top.pem
   U=$(openssl x509 -in local/tls/top.pem -noout -ext authorityInfoAccess | sed -n 's/.*CA Issuers - URI://p'); echo "$U"
   curl -fsS "$U" -o local/tls/ca.der && openssl x509 -inform DER -in local/tls/ca.der -out local/tls/ca.pem
   openssl x509 -in local/tls/ca.pem -noout -subject -issuer -fingerprint -sha256
   ```

   Expected: a CA URL (`http://…lencr.org/` for a Let's Encrypt chain),
   then a subject equal to the issuer at the top of the chain (e.g.
   `ISRG Root YR`). If `openssl` can't load `ca.der`, the file is PEM:
   `cp local/tls/ca.der local/tls/ca.pem`. **Compare the SHA-256
   fingerprint with the one listed for that certificate on
   <https://letsencrypt.org/certificates/>** (the download is plain HTTP;
   the fingerprint makes it trustworthy). Stop if it does not match.

3. Point curl and Node at it from `.env` (Debian/Ubuntu bundle path):

   ```sh
   cat /etc/ssl/certs/ca-certificates.crt local/tls/ca.pem > local/tls/curl-bundle.pem
   printf '%s\n' "CURL_CA_BUNDLE=$PWD/local/tls/curl-bundle.pem" "NODE_EXTRA_CA_CERTS=$PWD/local/tls/ca.pem" >> .env
   sed -i '/^PLEX_E2E_IGNORE_TLS=/d' .env && unset PLEX_E2E_IGNORE_TLS
   set -a; . ./.env; set +a
   ```

   Re-run the `cat` after a `ca-certificates` update.

4. Check without the workarounds:

   ```sh
   curl -sS -o /dev/null -w 'curl: %{http_code}\n' "$PLEX_URL/identity"   # expect curl: 200
   node -e 'fetch(process.env.PLEX_URL + "/identity").then(r => console.log("node:", r.status), e => console.log("node:", e.cause?.code ?? e.message))'   # expect node: 200
   npx playwright test   # expect the B4 result
   ```

   If only Chromium fails (`net::ERR_CERT_AUTHORITY_INVALID`), add the
   certificate to your user NSS store, which Chromium on Linux reads:
   `sudo apt install libnss3-tools`, then
   `certutil -d sql:$HOME/.pki/nssdb -A -t C,, -n plex-chain-ca -i local/tls/ca.pem`.
   Then stop using `-k` and the `NODE_TLS_REJECT_UNAUTHORIZED=0` prefix.
   Once your distribution and Node ship the root (step 1 passes without
   them), remove the two `.env` lines and `certutil -d sql:$HOME/.pki/nssdb -D -n plex-chain-ca`.
