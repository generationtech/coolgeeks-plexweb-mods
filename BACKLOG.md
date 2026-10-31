# BACKLOG

Work that needs the owner's real Plex server or homelab. Each item has
exact commands and the expected result, so a future session (or the owner)
can run it without asking questions.

Already done without the homelab (see `docs/anchor-research.md`): anchor
research on Plex Web 4.162.1 (PMS 1.43.5 package) and 4.163.0
(app.plex.tv); native-player adapter; the playQueue curl test and the e2e,
both green against a throwaway unclaimed PMS (`scripts/sandbox-pms.sh`).

Conventions:

- Run from the repo root on a machine that can reach the server (for
  Docker installs, the Docker host). `$VARS` come from your local `.env`
  (copy `.env.example`; never commit `.env`).
- Load the env into your shell first: `set -a; . ./.env; set +a`
- Record results in `docs/anchor-research.md` (findings log) using
  placeholders for ids, hostnames and library names. Anchor strings only.
- Order: B0 → B1 → B2 → B3 → B4. B5–B8 are optional.

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
`scripts/sandbox-pms.sh start`, then follow B4 against the env it prints.

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
files, so the injection must be re-applied (B5).

## B2. Your server's Plex Web version, preflighted

```sh
./injector/reapply.sh --snapshot          # -> bundle-snapshots/<type>-<timestamp>/ (gitignored)
SNAP=$(ls -d bundle-snapshots/*/ | tail -1)
ls "$SNAP"/js | grep -o 'plex-[0-9.]*-[0-9a-f]*' | sort -u   # Plex Web version
node dist/preflight.cjs --bundle-dir "$SNAP"
```

Expected: `chunk globals: webpackChunkplex_web_client` and
`RESULT: all required anchors resolved`. If your version is not 4.162.1 or
4.163.0, note it in the research doc's findings log. If preflight fails, the
report names the anchor and why. Fix `patches/play-from-here/plex-anchors.ts`
following the method in `docs/anchor-research.md` (`--find` lists module
ids, never code). The most likely casualty of a Plex Web update is
`bundle.startExistingPlayQueueAction` (an action nothing dispatches in
4.162.1); the fallback candidate is `ui/player/playerLifecycle/startPlayback`.

## B3. E2E auth on your (claimed) server

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
`X-Plex-Token` of any request), into `.env` only. Expected: `1 passed`.
If the run shows a sign-in screen, find the key(s) holding the token in a
signed-in browser (DevTools > Application > Local Storage for `$PLEX_URL`),
put them in `TOKEN_STORAGE_KEYS` in `e2e/auth.ts`, and promote the note
there to verified. Set `PLEX_E2E_SORT_LABEL` to a sort your library offers
(default `Year`). Debug with `PW_TRACE=1` (traces and screenshots can contain
the token and library names: keep them local, they are gitignored).

## B4. First real apply, then e2e against it

```sh
npm run build
./injector/reapply.sh --dry-run        # preflight report + a one-line diff of index.html; nothing written
./injector/reapply.sh                  # Linux may need: sudo env "PATH=$PATH" ./injector/reapply.sh
./injector/reapply.sh --verify         # needs PLEX_URL; fetches index.html and the runtime over HTTP
```

Expected: exit 0, `verified: index.html references plexweb-mods.js?v=<hash>`,
`HTTP verify: index.html served with the new tag (Cache-Control: no-cache)`,
and `HTTP verify: runtime served and matches the build`. In the browser:
hard-reload once (Ctrl+Shift+R), open a library's **Library** tab, sort it,
open an item's "..." menu, and you should see "Play from here" under
"Play Next". In the DevTools console:

```js
document.documentElement.dataset.plexwebModsStatus   // expect "ok"
__plexwebMods.printReport({ final: true })
```

Then the e2e against the applied install:

```sh
PLEX_E2E_INJECT=server npx playwright test   # expect: 1 passed
```

Rollback at any time: `./injector/reapply.sh --uninstall` (restores
index.html byte for byte, removes the runtime file and the backup).

## B5. (optional) Re-apply automatically after PMS updates

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

## B6. (optional) E2E in CI against the sandbox PMS

`scripts/sandbox-pms.sh` runs on a plain Linux box with no account, so the
e2e could run on GitHub-hosted runners (no self-hosted runner needed):
add a job that installs `ffmpeg`, runs `npm ci && npm run build`,
`scripts/sandbox-pms.sh start`, `npx playwright install --with-deps chromium`,
evaluates the printed env, then runs `npx playwright test` in both injection
modes. Expected: green in a few minutes (the package download is about 80 MB).
Decide first whether downloading PMS on every CI run is acceptable to you.

## B7. (optional) Self-hosted runner for e2e against the homelab, with fork-PR protections

Only if B6 is not enough (e.g. to test your real libraries). A
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

## B8. (optional) Hardening, no server needed

- Pin GitHub Actions to commit SHAs and pin the gitleaks tarball's sha256
  in `scripts/ci/install-gitleaks.sh` (today it checks the release's own
  checksums file).
- Localized UIs: `dom.menuAnchorLabels` holds English labels. Plex Web ships
  `translations/<lang>.json` (English source string → translation), so the
  runtime could load the active language's labels instead.
