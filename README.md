# coolgeeks-plexweb-mods

Runtime mods for a **self-hosted Plex Web client**: the copy Plex Media
Server serves at `:32400/web`. Re-appliable after every PMS update.

**First mod: "Play from here".** On any item in a sorted library view,
start playback in the browser at that item and continue through the list
in the visible sort order.

## How it works

```
reapply.sh ──copies──> <Plex Web dir>/plexweb-mods.js
           ──adds one <script> (before Plex's own scripts)──> index.html

in the browser, before Plex Web's webpack runtime runs:
  runtime/loader     hooks webpack (Function.prototype.m + chunk globals) so every
                     module factory passes through the patch engine first
  runtime/engine     string-anchored find/replace + export capture (Vencord-style);
                     tracks every anchor and fails loudly and specifically
  play-from-here     watches Plex Web's own listing requests (section, sort, filters),
                     adds "Play from here" under "Play Next" in the item menu, then
                     POST /playQueues?uri=<sorted section listing>&key=/library/metadata/<item>&shuffle=0
                     and starts it with Plex Web's own "start existing play queue" action
```

Everything Plex-specific sits in one file per mod
(`patches/play-from-here/plex-anchors.ts`), each anchor marked `documented`,
`unverified` or `verified`. Swapping in real anchors touches nothing else.

## Usage

Requirements: Node ≥ 22.12, and for development, gitleaks. In the browser,
Plex Web must be served without a Content-Security-Policy that blocks
`eval` (PMS sends none). If a reverse proxy adds one, `script-src` needs
`'self'` and `'unsafe-eval'`. No inline script is used. `npm ci` installs
the pre-commit hook (gitleaks, lint, tests). When the `node` on PATH is
missing or too old, as in some editors' git panels, the hook loads
`$NVM_DIR/nvm.sh` (default `~/.nvm`) itself.

```sh
npm ci && npm run build
cp .env.example .env                    # fill in; never commit .env
./injector/reapply.sh --status          # where is Plex Web, is it injected?
./injector/reapply.sh --dry-run         # preflight + diff, writes nothing
./injector/reapply.sh                   # apply (idempotent; refuses if preflight fails)
./injector/reapply.sh --uninstall       # byte-identical restore
./injector/reapply.sh --verify-served   # HTTP only: does PMS serve this build? (any install type)
```

Linux package installs usually need root to write the Plex Web directory:
`sudo env "PATH=$PATH" ./injector/reapply.sh`. Container installs: see below.

## Container installs

**Writable container** (`PLEX_INSTALL_TYPE=docker` or `podman`,
`PLEX_CONTAINER=<name>`): the injector works through `<engine> exec` /
`<engine> cp`, with the same preflight, backup and uninstall. Recreating the
container (image update, or any start of a `--rm` container) restores Plex's
files, so re-run it after each start (BACKLOG B6); the injector says so when
the container runs with `--rm`.

**Read-only root filesystem** (`--read-only`, e.g. a hardened Podman unit):
nothing can be changed in place, and the injector refuses up front (exit 1)
rather than fail halfway. `--status`, `--dry-run` and `--snapshot` still work.
Build a **derived image** instead; it also survives every recreate:

```sh
npm run build                      # also writes the build context dist/image/
# copy dist/image/ to the host that holds your Plex image, then there:
./build-image.sh --plex-image <your plex image> \
  --node-image docker.io/library/node:22-bookworm-slim@sha256:<digest> \
  --tag <your plex image name>-mods:<version>
# point the container definition at the new tag; restart
# back on the workstation (needs PLEX_URL; reads nothing but HTTP):
./injector/reapply.sh --verify-served
```

A throwaway Node stage runs the injector, preflight included, against the
Plex Web inside your image. If a required anchor fails, the build fails and
your running image is untouched. The result is your image plus one layer
with `index.html` and `plexweb-mods.js`; user, entrypoint and everything
else are inherited. Rebuild after every Plex image update. Details:
[image/README.md](image/README.md).

| Command | Purpose |
| --- | --- |
| `npm test` | unit tests (no server needed) |
| `npm run lint` | eslint + typecheck |
| `npm run build` | `dist/plexweb-mods.js`, `dist/injector.cjs`, `dist/preflight.cjs`, `dist/fetch-plex-web.cjs`, and the image build context `dist/image/` |
| `npm run preflight -- --bundle-dir <dir>` | read-only anchor report for a Plex Web dir (exit 1 on failure) |
| `npm run preflight -- --bundle-dir <dir> --find "Play Next"` | research: which modules contain a string (ids only) |
| `./injector/reapply.sh --snapshot` | copy the server's Plex Web into gitignored `bundle-snapshots/` |
| `npm run test:e2e` | Playwright against a real server; skips when `PLEX_URL` is unset |
| `scripts/sandbox-pms.sh start` | throwaway unclaimed PMS (latest package, localhost only, four generated libraries) for e2e |
| `npm run secrets` | gitleaks over the full history |

Runtime options are passed as `--opt key=value` and end up as
`data-opt-*` attributes on the injected tag: `pfh-companion=off` disables
the experimental companion fallback, `pfh-scheme=library` uses
`library://` URIs, `pfh-drop-params=a,b` drops extra listing params,
`pfh-route-check=off` offers the menu entry without the route check.
`pfh-player=primary|fallback|companion` forces a playback path (default:
auto). `--no-banner` keeps failures in the console only. In the browser,
`localStorage["plexweb-mods:debug"] = "1"` turns on debug logging, and
`__plexwebMods.printReport({ final: true })` prints the anchor report.

## Layout

| Path | What |
| --- | --- |
| `runtime/` | loader (webpack hooks), patch engine, bootstrap, config, UI |
| `patches/play-from-here/` | patch definitions, pure playQueue builder, Plex bindings behind small interfaces |
| `image/` | derived container image (Containerfile, build wrapper) for read-only or recreated Plex containers |
| `injector/` | reapply tool + `reapply.sh` wrapper (Linux package, Docker and Podman; refuses read-only containers) |
| `preflight/` | module extraction from bundle files, anchor report, `--find` |
| `tools/` | public Plex Web snapshot tool |
| `test/` | unit tests, synthetic fake webpack 4/5 bundles, real webpack 5 build |
| `e2e/` | Playwright e2e (token auth injected into storage; never a stored login) |
| `docs/anchor-research.md` | anchor findings (anchor strings only) |
| `research/sandbox-probes/` | the one-off sandbox scripts behind those findings (historical; e2e supersedes them) |
| `local/` | gitignored owner-only notes and tools (homelab specifics); the hook and gitleaks refuse it even with `git add -f`; the hook also refuses words listed in `local/denylist.txt` |
| `BACKLOG.md` | everything that needs the real server, with exact commands |
| `CLAUDE.md` | standing rules for this public repo |

## STATUS

_Last updated: 2026-11-01 (session 5)._

**"Play from here" works end to end against a real Plex Media Server.**
Tested on PMS 1.43.5.11079 with its bundled Plex Web 4.162.1, in a
throwaway sandbox (unclaimed, localhost only, no account, generated media;
reproducible with `scripts/sandbox-pms.sh start`). The e2e suite has 8 tests:

1. library grid, Detail View and Table View, each after a non-default sort;
2. a TV season page ("Play from here" on an episode);
3. an Other Videos library;
4. a 300-item library: PMS windows the queue (41 of 300 items by default),
   and Plex Web's Next/Previous follow the visible sort across both window
   edges;
5. unpaused autoplay in that library (2-second clips): every automatically
   started item is the next one in visible order, past the first window's
   end (visible #30 to #52, 23 items, on both player paths);
6. the companion fallback, forced: PMS rejects it (404), which pins down
   why that path cannot work with Plex Web (see below).

In tests 1–5, `GET /playQueues/<id>` selects the clicked item at its
visible index, with the items before and after it in visible order.
Playback starts in Plex Web's own player and the runtime anchor report is
clean. They pass with the runtime injected by request interception and
with it applied by the injector, on either native player path; test 6 runs
in interception mode only. CI runs the suite against a fresh sandbox on
every push, in all three modes (interception on the auto path, interception
with the fallback forced, injector-applied). The latest full run
(2026-11-01, commit `4df72d6`) is green in every job on the Node 24
actions. The sandbox e2e failed twice in session 5, at different steps,
once on the commit the session started from, and passed again with the
same PMS release: it is flaky (BACKLOG B11).

- **Native player, two paths** (group `play-from-here/player`; preflight and
  the runtime print which is active):
  - **primary:** Plex Web's "start existing play queue" action;
  - **fallback:** its "queue playback" action, pointed at the same queue.
    It ends and resets an open player first, so it replaces the queue
    rather than appending.

  Both were forced and verified live (`--opt pfh-player=primary|fallback`).
- **Companion fallback: not usable with Plex Web.** Forced in the sandbox,
  PMS answers 404 to `playMedia` aimed at Plex Web, and its `/clients` list
  stays empty. The bundle shows why: Plex Web 4.162.1 only *sends* remote-control
  commands (it's a controller) and never declares itself a player. The
  path stays as a last resort with an accurate error message. Whether a
  *claimed* server changes anything is the one open question (BACKLOG B4:
  the companion e2e test against a claimed server).
- **Anchors:** every Plex-coupled anchor in `plex-anchors.ts` is verified
  except the companion one. Preflight is green on 4.160.0 (the PMS
  1.43.4.10903 package, checked offline), 4.162.1, and the initial chunks of
  4.163.0 from app.plex.tv. Live runs so far used 4.162.1 only. See
  `docs/anchor-research.md`.
- **Workstation development:** the pre-commit hook loads nvm's Node when a
  GUI git client runs it without Node 22 on PATH. Owner-only notes live in
  the gitignored `local/`; the hook and a gitleaks rule refuse it even when
  force-added, and the hook refuses any word from the private
  `local/denylist.txt` in staged changes.
- **Container installs:** the injector works in place in writable Docker or
  Podman containers. It refuses read-only ones up front, pointing to the
  **derived image** (`image/`): your Plex image plus one layer with
  `index.html` and the runtime, built by a throwaway Node stage whose
  preflight fails the build on a broken anchor. The patch stage was run
  locally against the real Plex Web 4.160.0 (layer = the two files;
  `index.html` = original + one line). `--verify-served` checks a deployed
  image over HTTP from the workstation.
- **PMS API:** a sorted section or season `uri` plus `key` yields the visible
  order from the clicked item on; filters are honoured. Plex Web's own
  library Play button sends the same `uri` without `key`.
- **Tooling:** 272 unit tests. CI on GitHub-hosted runners runs gitleaks,
  lint, tests, the build, the sandbox e2e, and a real podman build of the
  derived image against synthetic Plex bases (one must pass, one must fail
  on preflight; `scripts/ci/image-smoke.sh`), using Node 24 actions
  (`actions/checkout@v7`, `actions/setup-node@v7`, `actions/cache@v6`). The
  PMS package is cached by release version; no secrets are used.

**Not verified yet (needs the owner's server, see BACKLOG.md):**

- the container host checks, the `*.plex.direct` URL and the absence of a
  CSP header (B1);
- a live e2e on a *claimed* server with a token, server untouched: the
  token storage key in `e2e/auth.ts`, the runtime on Plex Web 4.160.0, and
  the companion check (B4);
- the derived image built from a real Plex image and deployed (B5).

The weekly breakage canary (B8) is designed but not built.

**Next:** BACKLOG.md B1 → B2 → B4 → B5 (B3 is already done offline for
PMS 1.43.4.10903). The workstation's curl and Node do not trust the root at
the top of the server's plex.direct chain yet (Let's Encrypt
`ISRG Root YR`), so for now the curl checks use `-k` and the e2e
`PLEX_E2E_IGNORE_TLS=1` (BACKLOG B1 note). Optional: B6 (rebuild after
Plex updates), B8 (weekly canary), B12 (trust that chain on the
workstation).

## License

MIT. See `LICENSE`. This repo contains no Plex code; Plex and Plex Web are
trademarks of Plex, Inc. This project is not affiliated with Plex.
