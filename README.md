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

Requirements: Node ≥ 22.12, and for development, gitleaks.

```sh
npm ci && npm run build
cp .env.example .env                    # fill in; never commit .env
./injector/reapply.sh --status          # where is Plex Web, is it injected?
./injector/reapply.sh --dry-run         # preflight + diff, writes nothing
./injector/reapply.sh                   # apply (idempotent; refuses if preflight fails)
./injector/reapply.sh --uninstall       # byte-identical restore
```

Linux package installs usually need root to write the Plex Web directory:
`sudo env "PATH=$PATH" ./injector/reapply.sh`. Docker installs
(`PLEX_INSTALL_TYPE=docker`) go through `docker exec` / `docker cp`.

| Command | Purpose |
| --- | --- |
| `npm test` | unit tests (no server needed) |
| `npm run lint` | eslint + typecheck |
| `npm run build` | `dist/plexweb-mods.js`, `dist/injector.cjs`, `dist/preflight.cjs`, `dist/fetch-plex-web.cjs` |
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
| `injector/` | reapply tool + `reapply.sh` wrapper (Linux package and Docker) |
| `preflight/` | module extraction from bundle files, anchor report, `--find` |
| `tools/` | public Plex Web snapshot tool |
| `test/` | unit tests, synthetic fake webpack 4/5 bundles, real webpack 5 build |
| `e2e/` | Playwright e2e (token auth injected into storage; never a stored login) |
| `docs/anchor-research.md` | anchor findings (anchor strings only) |
| `BACKLOG.md` | everything that needs the real server, with exact commands |
| `CLAUDE.md` | standing rules for this public repo |

## STATUS

_Last updated: 2026-10-31 (session 4)._

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
every push, in all three modes (the first run with the Node 24 actions was
in progress when this was written).

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
  *claimed* server changes anything is the one open question (BACKLOG B5
  home checklist).
- **Anchors:** every Plex-coupled anchor in `plex-anchors.ts` is verified
  except the companion one. Preflight is green on 4.162.1 and on the
  initial chunks of 4.163.0 from app.plex.tv. See `docs/anchor-research.md`.
- **PMS API:** a sorted section or season `uri` plus `key` yields the visible
  order from the clicked item on; filters are honoured. Plex Web's own
  library Play button sends the same `uri` without `key`.
- **Tooling:** 224 unit tests. CI on GitHub-hosted runners runs gitleaks,
  lint, tests, the build and the sandbox e2e, using Node 24 actions
  (`actions/checkout@v7`, `actions/setup-node@v7`, `actions/cache@v6`). The
  PMS package is cached by release version; no secrets are used.

**Not verified yet (needs the owner's server, see BACKLOG.md):**

- the install path on the real server (B1);
- updating it to PMS 1.43.5 or later (B2), then its Plex Web version and
  preflight (B3);
- e2e auth with a token on a *claimed* server (the storage key in
  `e2e/auth.ts`, B4);
- the first real apply, including the companion check (B5).

The weekly breakage canary (B8) is designed but not built.

**Next:** BACKLOG.md B1 → B2 → B3 → B4 → B5. Optional: B6 (auto-reapply
after PMS updates), B8 (weekly canary).

## License

MIT. See `LICENSE`. This repo contains no Plex code; Plex and Plex Web are
trademarks of Plex, Inc. This project is not affiliated with Plex.
