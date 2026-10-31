# BACKLOG

Work that needs the owner's real Plex server or homelab, plus designed but
unbuilt automation. Each item has exact commands and the expected result,
so a future session (or the owner) can run it without asking questions.

Already done without the homelab (see `docs/anchor-research.md`): anchor
research on Plex Web 4.162.1 (PMS 1.43.5 package) and 4.163.0
(app.plex.tv); both native-player paths (primary and fallback); the
playQueue curl test; and the e2e suite (grid, Detail/Table View, TV season,
Other Videos, 300-item windowing), green against a throwaway unclaimed PMS
(`scripts/sandbox-pms.sh`) locally and in CI on every push.

Conventions:

- Run from the repo root on a machine that can reach the server (for
  Docker installs, the Docker host). `$VARS` come from your local `.env`
  (copy `.env.example`; never commit `.env`).
- Load the env into your shell first: `set -a; . ./.env; set +a`
- Record results in `docs/anchor-research.md` (findings log) using
  placeholders for ids, hostnames and library names. Anchor strings only.
- Order: B0 → B1 → B2 → B3 → B4 → B5. B6–B10 are optional.

---

## B0. One-time setup on the machine that runs the tools

```sh
git clone https://github.com/generationtech/coolgeeks-plexweb-mods && cd coolgeeks-plexweb-mods
git checkout claude/plex-play-from-here-rzg61g   # until it is merged
node --version          # expect v22.12 or newer
npm ci                  # also installs the pre-commit hook
npm test                # expect: all tests pass, 0 failed
npm run build           # expect: dist/plexweb-mods.js, dist/injector.cjs, dist/preflight.cjs, dist/fetch-plex-web.cjs
cp .env.example .env    # then fill in PLEX_URL, PLEX_TOKEN, PLEX_SECTION_ID, PLEX_INSTALL_TYPE
```

Expected: the build succeeds, `.env` exists, and `git status` does not list
`.env` (it is ignored). Optional rehearsal with no server and no account:
`scripts/sandbox-pms.sh start`, then follow B5 against the env it prints.

## B1. Identify the install type and the Plex Web path

The PMS 1.43.5 package puts Plex Web at
`/usr/lib/plexmediaserver/Resources/Plug-ins-<build>/WebClient.bundle/Contents/Resources`;
the injector auto-discovers it. To confirm:

Linux package install:

```sh
dpkg -s plexmediaserver 2>/dev/null | grep -i '^version' || rpm -q plexmediaserver
sudo find /usr/lib/plexmediaserver -path '*WebClient.bundle/Contents/Resources/index.html'
```

Docker install:

```sh
docker ps --format '{{.Names}}\t{{.Image}}' | grep -i plex
docker exec <container> find /usr/lib/plexmediaserver -path '*WebClient.bundle/Contents/Resources/index.html'
```

Expected: exactly one path. Put `PLEX_INSTALL_TYPE=linux|docker` and, for
Docker, `PLEX_DOCKER_CONTAINER=<name>` in `.env`. Set `PLEX_WEB_DIR` only if
auto-discovery fails. Then:

```sh
./injector/reapply.sh --status      # Linux may need: sudo env "PATH=$PATH" ./injector/reapply.sh --status
```

Expected: `discovered Plex Web at ...`, `index.html: pristine (not injected)`.
Docker note: recreating the container (image update) restores the original
files, so the injection must be re-applied (B6).

## B2. Update your server to PMS 1.43.5 or later (before B3)

The mod is verified against Plex Web 4.162.1, the copy bundled with PMS
1.43.5.11079 (and preflighted against 4.163.0 from app.plex.tv). Older
servers ship older Plex Web builds that may lack the anchored actions, so
update first; newer is fine (the weekly canary, B8, watches new releases).

```sh
curl -s -H 'Accept: application/json' "$PLEX_URL/identity" | node -pe 'JSON.parse(require("fs").readFileSync(0)).MediaContainer.version'
```

Expected after updating: `1.43.5.11079-b3b13e506` or a later version.

- Linux package: install the current release from plex.tv's download page
  (or your distro repo), e.g. `sudo apt-get update && sudo apt-get install plexmediaserver`,
  then `systemctl is-active plexmediaserver` (expect `active`).
- Docker: pull the image tag that carries 1.43.5 or later and recreate the
  container (the official image can also update itself on start when
  configured to); re-check the version with the command above.

Updating PMS replaces Plex Web, so anything applied before must be applied
again (B5, then B6 to automate it).

## B3. Your server's Plex Web version, preflighted

```sh
./injector/reapply.sh --snapshot          # -> bundle-snapshots/<type>-<timestamp>/ (gitignored)
SNAP=$(ls -d bundle-snapshots/*/ | tail -1)
ls "$SNAP"/js | grep -o 'plex-[0-9.]*-[0-9a-f]*' | sort -u   # Plex Web version
node dist/preflight.cjs --bundle-dir "$SNAP"
```

Expected: `chunk globals: webpackChunkplex_web_client`,
`group play-from-here/player: active = play-from-here/native-player; standby = play-from-here/native-player-fallback`,
and `RESULT: all required anchors resolved`. After B2 your Plex Web should be
4.162.1 or newer; if it is not 4.162.1 or 4.163.0, note it in the research
doc's findings log (the weekly canary, B8, checks new releases too). If preflight fails, the
report names the anchor and why. Fix `patches/play-from-here/plex-anchors.ts`
following the method in `docs/anchor-research.md` (`--find` lists module
ids, never code). The most likely casualty of a Plex Web update is
`bundle.startExistingPlayQueueAction` (an action nothing dispatches in
4.162.1). If only it breaks, the group line shows the fallback
(`queuePlayback`) as active and playback keeps working; fix the primary at
leisure.

## B4. E2E auth on your (claimed) server

The sandbox server was unclaimed and needed no token. A claimed server
does, so the e2e injects `PLEX_TOKEN` into browser storage
(`e2e/auth.ts`, key `myPlexAccessToken`). That storage key is the one
remaining unverified e2e assumption.

```sh
curl -s -o /dev/null -w '%{http_code}\n' -H "X-Plex-Token: $PLEX_TOKEN" "$PLEX_URL/library/sections"   # expect 200
npx playwright install chromium        # on the machine running e2e
npm run build && npx playwright test   # route mode: injects the local build via interception; server untouched
```

Get the token from a signed-in Plex Web (DevTools > Network: the
`X-Plex-Token` of any request), into `.env` only. Expected: the grid and
Detail/Table View tests pass (`3 passed`); the TV, Other Videos and 300-item
tests skip unless you set `PLEX_E2E_TV_SECTION_ID`, `PLEX_E2E_OTHER_SECTION_ID`,
`PLEX_E2E_BIG_SECTION_ID` (a library with 100+ items) in `.env`. If the run
shows a sign-in screen, find the key(s) holding the token in a signed-in
browser (DevTools > Application > Local Storage for `$PLEX_URL`), put them
in `TOKEN_STORAGE_KEYS` in `e2e/auth.ts`, and promote the note there to
verified. Set `PLEX_E2E_SORT_LABEL` to a sort your library offers (default
`Year`). Debug with `PW_TRACE=1` (traces and screenshots can contain the
token and library names: keep them local, they are gitignored).

## B5. First real apply, then e2e against it

```sh
npm run build
./injector/reapply.sh --dry-run        # preflight report + a one-line diff of index.html; nothing written
./injector/reapply.sh                  # Linux may need: sudo env "PATH=$PATH" ./injector/reapply.sh
./injector/reapply.sh --verify         # needs PLEX_URL; fetches index.html and the runtime over HTTP
```

Expected: exit 0, `group play-from-here/player: active = play-from-here/native-player; ...`,
`verified: index.html references plexweb-mods.js?v=<hash>`,
`HTTP verify: index.html served with the new tag (Cache-Control: no-cache)`,
and `HTTP verify: runtime served and matches the build`. In the browser:
hard-reload once (Ctrl+Shift+R), open a library's **Library** tab, sort it,
open an item's "..." menu, and you should see "Play from here" under
"Play Next" (also on a TV season page). In the DevTools console:

```js
document.documentElement.dataset.plexwebModsStatus           // expect "ok"
__plexwebMods.plugins["play-from-here"].activePath()        // expect { path: "native" }
__plexwebMods.printReport({ final: true })
```

Then the e2e against the applied install:

```sh
PLEX_E2E_INJECT=server npx playwright test   # expect: the same passes as in B4
```

Optional: prove the fallback on your install too:
`./injector/reapply.sh --opt pfh-player=fallback`, rerun the e2e (it then
expects the `native-fallback` path), then `./injector/reapply.sh` again to
go back to auto.

Rollback at any time: `./injector/reapply.sh --uninstall` (restores
index.html byte for byte, removes the runtime file and the backup).

## B6. (optional) Re-apply automatically after PMS updates

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

## B7. (optional) Docker: confirm the injector path inside the official image

The injector's Docker mode is tested against an emulated container only.
With a Docker install, B1 and B5 exercise it for real; if
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
  - Hosted Plex Web: `curl -s https://app.plex.tv/desktop/index.html | grep -o 'plex-[0-9.]*-[0-9a-f]*' | sort -u`.
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

- `actions/cache@v4` targets Node 20, which GitHub now forces onto Node 24
  (a warning in the e2e job log); move to the next major when it exists.
- Pin GitHub Actions to commit SHAs and pin the gitleaks tarball's sha256
  in `scripts/ci/install-gitleaks.sh` (today it checks the release's own
  checksums file).
- Localized UIs: `dom.menuAnchorLabels` holds English labels. Plex Web ships
  `translations/<lang>.json` (English source string → translation), so the
  runtime could load the active language's labels instead.
