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
                     adds "Play from here" to the item menu, then
                     POST /playQueues?uri=<sorted section listing>&key=/library/metadata/<item>&shuffle=0
                     and hands the queue to Plex Web's native player
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
| `npm run secrets` | gitleaks over the full history |

Runtime options are passed as `--opt key=value` and end up as
`data-opt-*` attributes on the injected tag: `pfh-companion=off` disables
the experimental companion fallback, `pfh-scheme=library` uses
`library://` URIs, `pfh-drop-params=a,b` drops extra listing params,
`pfh-route-check=off` offers the menu entry without the route check.
`--no-banner` keeps failures in the console only. In the browser,
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

_Last updated: 2026-10-31._

**Built and tested without a server** (198 unit tests, green locally and in CI
on GitHub-hosted runners: gitleaks full-history scan, lint + typecheck,
unit tests, build):

- Repo rules (`CLAUDE.md`), `.gitignore`, `.env.example`, gitleaks config with
  Plex-specific rules (tokens, machine ids, section UUIDs, plex.direct names,
  LAN IPs) and tests for those rules, pre-commit hook, CI.
- Patch engine + webpack loader: proven against hand-written webpack 4/5
  bundles and a real webpack 5 production build (runtime chunk, split
  chunk, lazy chunk), with anchors resolving and failing exactly as
  reported.
- Play from here: playQueue request construction (sorts, filters,
  sections, keys, both URI schemes) fully unit-tested; listing detection
  from Plex Web's own requests; DOM menu entry; flow with step-specific
  errors.
- Injector: apply / dry-run / uninstall / status / snapshot, backup,
  cache-busting (`?v=<content hash>`, service-worker warning, HTTP verify),
  preflight gate, Linux and Docker (Docker path tested against an emulated
  container).
- Preflight: read-only, acorn-based module extraction, same engine as the
  runtime, `--find` for research.
- E2E skeleton: sort → mid-list "Play from here" → `GET /playQueues/<id>`
  order assertion; skips without `PLEX_URL`.

**Not verified yet (needs the real server or bundle):**

- Plex Web could not be downloaded here: `app.plex.tv` / `plex.tv` are
  blocked by this environment's network policy. **Every Plex Web anchor is
  `unverified`** (bundle strings, DOM selectors, routes, e2e selectors and
  storage keys).
- The native-player hook is a placeholder: the patch is marked `todo`, so
  preflight and the runtime report `PATCH_INCOMPLETE` and the injector
  refuses to apply without `--force`. Until it is written, playback can only
  start through the experimental companion fallback, which is untested.
- The `POST /playQueues` request shape has not been tried against PMS yet.

**Next:** BACKLOG.md B1 (find the install and the Plex Web path) → B2 (version)
→ B3 (curl the playQueue) → B4 (snapshot + preflight + research) → B5 (native
player adapter) → B6 (e2e auth) → B7 (first real apply + e2e).

## License

MIT. See `LICENSE`. This repo contains no Plex code; Plex and Plex Web are
trademarks of Plex, Inc. This project is not affiliated with Plex.
