# Anchor research: Plex Web

Findings about Plex Web internals that the mods depend on. **Anchor strings
only**: short strings, localization keys, API paths, attribute names, module
ids. Never code excerpts, never bundle files (those stay in the gitignored
`bundle-snapshots/`). Ids, hostnames and machine identifiers below are
placeholders.

## Snapshots (2026-10-31)

| | PMS package | app.plex.tv |
| --- | --- | --- |
| How | `plexmediaserver_1.43.5.11079-b3b13e506_amd64.deb` from downloads.plex.tv (SHA-1 matched plex.tv's published checksum), extracted, then `./injector/reapply.sh --snapshot` | `node dist/fetch-plex-web.cjs --url https://app.plex.tv/desktop/` |
| Dir | `bundle-snapshots/pms-1.43.5.11079-deb/` | `bundle-snapshots/app.plex.tv-2026-10-31/` |
| PMS version | 1.43.5.11079-b3b13e506 | n/a |
| **Plex Web version** | **4.162.1** (build `87b128e`) | **4.163.0** (build `8246fd2`) |
| Location in package | `usr/lib/plexmediaserver/Resources/Plug-ins-<build>/WebClient.bundle/Contents/Resources/` | `/desktop/` |
| JS files | 214 (every lazy chunk, `translations/`, `static/`) | 2 (initial scripts only) |
| Modules extracted by preflight | 3,118 (3,044 unique ids) | 2,610 |
| Chunk global | `webpackChunkplex_web_client` | `webpackChunkplex_web_client` |

**Differences.** The versions differ (4.162.1 bundled with the newest PMS,
4.163.0 live on app.plex.tv), so the public client runs ahead of the
bundled one. The main chunk differs by about 800 bytes. The URL snapshot
lacks every lazy chunk: webpack builds chunk URLs at runtime, so they can't
be discovered from `index.html`. That is why the menu labels show up in
fewer modules there. Every **required** anchor resolves in both, and the
player module even keeps the same id (34171). Research and live tests used
the complete package copy, since that is what PMS serves and what the
injector patches.

## Structure facts (4.162.1, also true for 4.163.0 where checkable)

- Webpack 5. The webpack **runtime is an inline `<script>` in
  `index.html`**, after two small inline scripts. The two initial chunk
  `<script>`s are plain (not `defer`) and carry **SRI `integrity`**
  attributes. We never modify Plex's files, so SRI is unaffected; our tag
  goes before Plex's first `<script>`.
- No service worker is registered (a dev-only `mockServiceWorker.js` file
  ships but is never registered).
- PMS serves `/web/index.html` with `Cache-Control: no-cache` and **no CSP
  header**, so `eval`-based replacement patches are allowed. PMS also
  serves extra files placed in the Plex Web dir (`/web/plexweb-mods.js`).
- Localization: English source strings are the keys; `translations/en.json`
  is empty and other languages map English to the translation (e.g. the
  German file translates `"Play Next"`).
- App architecture: Backbone-style models rooted at a service named
  `"appModel"` (looked up through a small service registry), plus maps of
  `actionType -> handler(appModel, payload, dispatch)` with namespaced
  action types such as `ui/player/playerLifecycle/...` and
  `ui/player/playQueue/...`. Redux and redux-saga sit in the vendor chunk.

## Research questions: answers

1. **Webpack-built?** Yes, webpack 5, chunk global `webpackChunkplex_web_client`.
2. **Does the library Play button send a sorted `uri`?** Yes. Observed live
   after sorting by Year: `POST /playQueues` with
   `uri=server://<machineId>/com.plexapp.plugins.library/library/sections/<id>/all?type=1&sort=year%3Adesc&includeCollections=1&includeExternalMedia=1`,
   `type=video`, and **no `key`**, so it plays the sorted list from the
   top. The bundle builds content URIs as
   `server://<serverIdentifier>/<providerIdentifier><path>`, and directory
   playback elsewhere pairs a directory path (`library:///directory/<encoded path>`)
   with an item `key`. "Play from here" uses the stock request shape plus `key`.
3. **Item context-menu definitions.** Labels `"Play Next"` and
   `"Add to Queue"` occur together in 6 modules (`"Add to Up Next"` no
   longer exists). In the DOM, menu entries are `role="menuitem"` buttons
   (`data-testid="dropdownItem"`) inside a portal div; the container has
   **no** `role="menu"`.
4. **Native player entry point.** The action type
   `ui/player/playerLifecycle/startExistingPlayQueuePlayback` occurs in exactly
   one module. Its exports include the action-handler map (keyed by that
   string). The handler takes `(appModel, payload)` with payload fields
   `serverEntityID`, `providerEntityID`, `playQueueType` (`video` / `audio` /
   `photo`), `playQueueID`, optional `startOffsetMilliseconds`,
   `startMediaIndex`, `playbackStartTime`. It opens the player, fetches the
   queue and starts playback. The same module looks up `"appModel"` once.
   App-model API used to build the payload: attribute `servers`, method
   `populateServer(<machineId>)`, attribute `providers`, method `populate`,
   method `entityID()`, provider id `com.plexapp.plugins.library`.
   Related action types: `.../startPlayback`, `.../queuePlayback`.
   - **Risk:** in 4.162.1 nothing dispatches this action. The handler exists
     and works, but its action creator is never exported or used, so Plex
     could drop it as dead code. Preflight would then fail loudly
     (`FIND_UNRESOLVED`); the next candidate is `.../startPlayback`.
5. **DOM and routes.** Library grid route
   `#!/media/<machineId>/com.plexapp.plugins.library?source=<sectionId>&pivot=library`
   (the section opens on `Recommended`, without `pivot`). Detail links
   `#!/server/<machineId>/details?key=%2Flibrary%2Fmetadata%2F<id>&context=...`,
   two per card (poster and title) inside `data-testid="cellItem"`. The card
   menu button is `aria-label="More Actions"`. The sort control is a popup
   button whose text is the current sort ("By Title", "By Year"), and its
   entries are `role="menuitem"`. Choosing "Year" makes the grid request
   `sort=year%3Adesc`.

All anchors in `patches/play-from-here/plex-anchors.ts` are now `verified`
except the companion fallback (`api.companionPlayMedia`), which is never
needed while the native player works.

## How the native-player patch uses this (no code from Plex)

- `find`: the action-type string plus `"appModel"`, which selects 1 module.
- One replacement: right after that module's `"use strict";`, insert a
  `$self` call that registers a getter for the module's own `"appModel"`
  lookup. The two minified identifiers of that lookup are captured by a
  regex, never hard-coded.
- `onExports`: find the export object that has the action-type key, i.e.
  the handler map, regardless of minified export names.
- At click time: resolve server and provider entity ids through the app
  model and call the handler with the created play queue.

## B3: POST /playQueues with a sorted uri + key (PMS 1.43.5, live)

Six-item movie library; `year:desc` order = 3, 5, 1, 6, 2, 4; `key` = item 1.

| `uri` variant | Result |
| --- | --- |
| `server://…/library/sections/1/all?type=1&sort=year:desc` | queue 3 5 1 6 2 4, selected offset 2 → from item 1: **1 6 2 4** |
| same, `sort=year%3Adesc` (encoded) | same |
| without `type=1` | same |
| with `includeCollections=1` | same |
| default sort (no `sort`) | 1 2 3 4 5 6, offset 0 |
| `library://<sectionUuid>/directory/<encoded path>` | same as first row |
| `library:///directory/<encoded path>` (no uuid) | same as first row |
| filter `year>>=1999` + `sort=year:desc` | 3 5 1 (filter honoured) |

The queue contains the **whole** list with the clicked item selected, not
only the items after it. The exact requests built by
`buildCreatePlayQueueRequest` gave the same results.

## Live run (sandbox, no account)

PMS 1.43.5 extracted from the package, unclaimed, `allowedNetworks`
limited to localhost, ffmpeg test videos (reproducible:
`scripts/sandbox-pms.sh start`). The API and Plex Web both work with no
token and no plex.tv sign-in. Plex Web shows a one-time "Plex Web Setup"
page per browser profile and a dismissible "server is unclaimed" notice.
Plex Web's and PMS's own calls to plex.tv services and telemetry were
refused by the sandbox network and were not needed.

- `reapply.sh` (preflight OK, apply, `--verify`, idempotent re-runs,
  `--uninstall` restoring `index.html` byte for byte): all green.
- e2e: sort by Year, then "Play from here" on the 3rd card. The menu entry
  sits between "Play Next" and "Add to Queue". The queue matches the visible
  order from the clicked item, playback starts in Plex Web's own player
  (`native` path), and the runtime anchor report is clean. After fixing one
  flake (waiting for the grid to re-render after sorting), all 12 runs passed,
  in both route-interception and applied modes, on two separate sandbox
  installs.

## Findings log

- 2026-10-31 (session 1): no bundle access in the build environment; nothing verified.
- 2026-10-31 (session 2): Plex Web 4.162.1 (PMS 1.43.5.11079) and 4.163.0
  (app.plex.tv) snapshotted; all anchors researched, replaced where wrong
  (`Add to Up Next`, `role=menu`), and verified by preflight plus a live run;
  native player adapter written; B3 and e2e pass against the sandbox PMS.
