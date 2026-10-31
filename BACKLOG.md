# BACKLOG

Work that needs the real Plex server or homelab. Each item has exact
commands and the expected result, so a future session (or the owner) can
run it without asking questions.

Conventions:

- Run from the repo root on a machine that can reach the server (for
  Docker installs, the Docker host). `$VARS` come from your local `.env`
  (copy `.env.example`; never commit `.env`).
- Load the env into your shell first: `set -a; . ./.env; set +a`
- Record results in `docs/anchor-research.md` (findings log) using
  placeholders for ids, hostnames and library names. Anchor strings only.
- Order: B0 → B1 → B2 → B3 → B4 → B5 → B6 → B7. B8 and B9 are optional.

---

## B0. One-time setup on the machine that runs the tools

```sh
git clone https://github.com/generationtech/coolgeeks-plexweb-mods && cd coolgeeks-plexweb-mods
node --version          # expect v22.12 or newer
gitleaks version        # expect 8.x (see CLAUDE.md for install options)
npm ci                  # also installs the pre-commit hook (core.hooksPath=.githooks)
npm test                # expect: all tests pass, 0 failed
npm run build           # expect: dist/plexweb-mods.js, dist/injector.cjs, dist/preflight.cjs, dist/fetch-plex-web.cjs
cp .env.example .env    # then fill in PLEX_URL, PLEX_TOKEN, PLEX_SECTION_ID, PLEX_INSTALL_TYPE
```

Expected: the build succeeds and `.env` exists. `git status` must not list
`.env` (it is ignored).

## B1. Identify the install type and the Plex Web path

Linux package install:

```sh
dpkg -s plexmediaserver 2>/dev/null | grep -i '^version' || rpm -q plexmediaserver
systemctl is-active plexmediaserver
sudo find /usr/lib/plexmediaserver /usr/lib64/plexmediaserver /opt/plexmediaserver \
  -path '*WebClient.bundle/Contents/Resources/index.html' 2>/dev/null
```

Docker install:

```sh
docker ps --format '{{.Names}}\t{{.Image}}' | grep -i plex
docker exec <container> find /usr/lib/plexmediaserver -path '*WebClient.bundle/Contents/Resources/index.html'
```

Expected: exactly one `.../WebClient.bundle/Contents/Resources/index.html`.
Put the result in `.env`: `PLEX_INSTALL_TYPE=linux|docker`,
`PLEX_WEB_DIR=<that directory, without /index.html>` (for Docker, the path
inside the container), `PLEX_DOCKER_CONTAINER=<name>`. Then:

```sh
./injector/reapply.sh --status        # Linux may need: sudo env "PATH=$PATH" ./injector/reapply.sh --status
curl -s -o /dev/null -w '%{http_code}\n' "$PLEX_URL/web/index.html"
```

Expected: `index.html: pristine (not injected)`, `runtime on target: absent`,
and HTTP `200`. If the path is somewhere else, set `PLEX_WEB_DIR` and also
add the root to `DEFAULT_SEARCH_ROOTS` in `injector/target-fs.ts` (with a
test). Docker note: recreating the container (image update) restores the
original files, so the injection must be re-applied (B8).

## B2. Compare the local Plex Web version with app.plex.tv

```sh
assets() { curl -sL "$1" | grep -oE '(src|href)="[^"]+\.(js|css)[^"]*"' | sort; }
assets "$PLEX_URL/web/index.html"            > /tmp/pw-local.txt
assets "https://app.plex.tv/desktop/index.html" > /tmp/pw-public.txt
diff /tmp/pw-local.txt /tmp/pw-public.txt && echo SAME BUILD
curl -s -H 'Accept: application/json' "$PLEX_URL/identity"   # PMS version
```

Expected: either `SAME BUILD`, or differing hashed file names (different
Plex Web versions). Either way, research and patch against the **local**
copy (that is what gets patched). Optionally snapshot the public one too
(this sandbox could not reach it; see docs/anchor-research.md):

```sh
NODE_USE_ENV_PROXY=1 node dist/fetch-plex-web.cjs --url https://app.plex.tv/desktop/
```

Expected: `saved N file(s) to bundle-snapshots/app.plex.tv-<date>`.
It only contains the initial chunks; the local snapshot (B4) is complete.

## B3. curl-test POST /playQueues with a sorted uri + key

```sh
MID=$(curl -s -H 'Accept: application/json' "$PLEX_URL/identity" \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).MediaContainer.machineIdentifier')
H=(-H 'Accept: application/json' -H "X-Plex-Token: $PLEX_TOKEN" -H 'X-Plex-Client-Identifier: plexweb-mods-curl')
keys() { node -pe 'JSON.parse(require("fs").readFileSync(0)).MediaContainer.Metadata.map(m=>m.ratingKey).join(" ")'; }

# 1. the sorted listing (movies section; adjust type for others)
curl -s "${H[@]}" "$PLEX_URL/library/sections/$PLEX_SECTION_ID/all?type=1&sort=year:desc&X-Plex-Container-Start=0&X-Plex-Container-Size=10" | keys
KEY=<the 4th key printed above>

# 2. create the queue from that item, in that order
URI="server://$MID/com.plexapp.plugins.library/library/sections/$PLEX_SECTION_ID/all?type=1&sort=year:desc"
curl -s -X POST --get "${H[@]}" \
  --data-urlencode type=video --data-urlencode "uri=$URI" \
  --data-urlencode "key=/library/metadata/$KEY" --data shuffle=0 --data repeat=0 \
  "$PLEX_URL/playQueues" | tee /tmp/pq.json | node -pe '
    const c = JSON.parse(require("fs").readFileSync(0)).MediaContainer;
    [c.playQueueID, c.playQueueSelectedItemOffset, c.playQueueSelectedMetadataItemID, c.Metadata.map(m=>m.ratingKey).join(" ")].join("\n")'
```

Expected: a `playQueueID`; `playQueueSelectedMetadataItemID` = `$KEY`; the
keys from the selected offset onward equal the sorted listing from `$KEY`
onward. Record whether items **before** `$KEY` are included (the code
handles both via `itemsFromSelected`). Then try the variants and record
which work (adjust `patches/play-from-here/playqueue.ts` plus its tests if
any differ):

- sort written encoded (`sort=year%3Adesc`) inside the uri: same result?
- without `type=1` in the uri;
- with `includeCollections=1` in the uri (does the queue expand collections? if it misbehaves, drop it by default via `DROPPED_LISTING_PARAMS`);
- `library://<section uuid>/directory/<url-encoded path>` (uuid from `curl -s "${H[@]}" "$PLEX_URL/library/sections"`, field `uuid`);
- a TV section (`type=2`: does a show expand to its episodes?) and music (`type=10`, queue `type=audio`).

Then the read-back used by e2e:

```sh
PQ=$(node -pe 'JSON.parse(require("fs").readFileSync("/tmp/pq.json")).MediaContainer.playQueueID')
curl -s "${H[@]}" "$PLEX_URL/playQueues/$PQ?window=200&own=1" | keys
```

Expected: the same order. Play queues are temporary; no cleanup needed.

## B4. Anchor research against the local bundle (preflight)

```sh
./injector/reapply.sh --snapshot      # read-only copy into bundle-snapshots/<type>-<timestamp>/ (gitignored)
SNAP=$(ls -d bundle-snapshots/*/ | tail -1)
node dist/preflight.cjs --bundle-dir "$SNAP"
node dist/preflight.cjs --bundle-dir "$SNAP" --find "Play Next" --find "Add to Up Next"
node dist/preflight.cjs --bundle-dir "$SNAP" --find /playQueues --find playQueueSelectedItemID
```

Expected: `chunk globals:` shows one `webpackChunk<name>` and thousands of
modules are extracted (if not, the bundle is not webpack or extraction
needs work: write that down and stop). Today the report is expected to
FAIL on `play-from-here/native-player`: `FIND_AMBIGUOUS` (anchors too broad)
and `PATCH_INCOMPLETE` (adapter not written). Work through the questions
in `docs/anchor-research.md` ("Open research questions"), update
`patches/play-from-here/plex-anchors.ts` (status `verified` plus the Plex
Web version), and log the findings (anchor strings only, never code).

## B5. Write the native-player adapter

With the module from B4 identified:

1. Narrow `bundle.nativePlayerModule` so preflight locates exactly 1 module.
2. In `createPatches()` (`patches/play-from-here/index.ts`), build a
   `NativePlayer` from the captured exports in `onExports`, call
   `plugin.registerNativePlayer(...)`, return `true`; or, if the entry point
   is not exported, use a `replacements` patch that calls
   `$self.registerNativePlayer(...)` from inside the module.
3. Remove `todo` from the native-player patch; set `all: false`.
4. Add a unit test with a synthetic module of the same *shape* (write it
   yourself; never paste Plex code).

Expected: `npm test` green and
`node dist/preflight.cjs --bundle-dir "$SNAP"` ends with
`RESULT: all required anchors resolved`.

Until then, the experimental companion fallback can be tried (needs Plex
Web Settings > "Advertise as player" enabled in that browser): apply with
`--force --no-banner` (B7) and use the menu entry. If it does not start
playback, apply with `--opt pfh-companion=off`. Record the result.

## B6. E2E auth and selectors

```sh
curl -s -o /dev/null -w '%{http_code}\n' -H "X-Plex-Token: $PLEX_TOKEN" "$PLEX_URL/library/sections"   # expect 200
npx playwright install chromium        # on the machine running e2e
npm run build && npx playwright test   # route mode: injects the local build via interception; server untouched
```

Get the token from a signed-in Plex Web (DevTools > Network: the
`X-Plex-Token` of any request), into `.env` only. Expected: the library
loads **without** a sign-in screen. If a sign-in screen appears, open
DevTools > Application > Local Storage for `$PLEX_URL` in a signed-in
browser, find the key(s) holding the token, and update
`TOKEN_STORAGE_KEYS` in `e2e/auth.ts`. Then fix the selectors in
`e2e/plex-ui.ts` (sort button and menu, card "more" button, player) until
the test reaches the "Play from here" click. Debug with
`PW_TRACE=1 npx playwright test` (traces and screenshots can contain the
token and library names: keep them local, they are gitignored).

## B7. First real apply, then e2e against it

```sh
npm run build
./injector/reapply.sh --dry-run        # preflight report + a one-line diff of index.html; nothing written
./injector/reapply.sh                  # Linux may need: sudo env "PATH=$PATH" ./injector/reapply.sh
./injector/reapply.sh --verify         # fetches $PLEX_URL/web/index.html and the runtime over HTTP
curl -sI "$PLEX_URL/web/index.html" | grep -i -E 'cache-control|content-security-policy'
```

Expected: exit 0, `verified: index.html references plexweb-mods.js?v=<hash>`,
and both `HTTP verify` lines. Exit 3 means preflight failed: go back to
B4/B5 (or `--force` to try the companion fallback knowingly). In the
browser: hard-reload once (Ctrl+Shift+R), then in the DevTools console:

```js
__plexwebMods.printReport({ final: true })
document.documentElement.dataset.plexwebModsStatus   // expect "ok"
```

If a `content-security-policy` header without `'unsafe-eval'` shows up,
replacement patches cannot compile (they report `COMPILE_ERROR`); export
captures need no eval and still work. Note it in the research doc.

Then the e2e against the applied install:

```sh
PLEX_E2E_INJECT=server npx playwright test   # expect: 1 passed
```

Rollback at any time: `./injector/reapply.sh --uninstall` (restores
index.html byte for byte, removes the runtime file and the backup).

## B8. (optional) Re-apply automatically after PMS updates

Re-running is safe: reapply is idempotent and, after an update, refuses to
patch if preflight fails (Plex stays untouched; exit 3).

Linux (systemd path unit; the reapply's own write triggers one extra run,
which is a no-op):

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

Docker: run `./injector/reapply.sh` after every container (re)start, e.g. a
cron entry `*/15 * * * * cd /path/to/repo && ./injector/reapply.sh >> ~/plexweb-mods.log 2>&1`.

## B9. (optional) Self-hosted runner for e2e, with fork-PR protections

CI stays on GitHub-hosted runners. A self-hosted runner on a public repo
is risky; only add one for e2e, and only like this:

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

## B10. Housekeeping (no server needed, low priority)

- Merge the session branch `claude/plex-play-from-here-rzg61g` into `main`
  (this session's harness could only push to that branch).
- Pin GitHub Actions to commit SHAs and pin the gitleaks tarball's sha256
  in `scripts/ci/install-gitleaks.sh` (today it checks the release's own
  checksums file).
- Localized UIs: `dom.menuAnchorLabels` holds English labels only.
