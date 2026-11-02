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
     could drop it as dead code. That is why a fallback exists (next item).
5. **DOM and routes.** Library grid route
   `#!/media/<machineId>/com.plexapp.plugins.library?source=<sectionId>&pivot=library`
   (the section opens on `Recommended`, without `pivot`). Detail links
   `#!/server/<machineId>/details?key=%2Flibrary%2Fmetadata%2F<id>&context=...`,
   two per card (poster and title) inside `data-testid="cellItem"`. The card
   menu button is `aria-label="More Actions"`. The sort control is a popup
   button whose text is the current sort ("By Title", "By Year"), and its
   entries are `role="menuitem"`. Choosing "Year" makes the grid request
   `sort=year%3Adesc`.
6. **Fallback player (session 3).** Two candidates from the same handler map:
   - `ui/player/playerLifecycle/startPlayback` (the BACKLOG's candidate) was
     **rejected**. It takes an item entity plus `options.containerKey`, but
     Plex Web's queue builder only uses "directory + key" for the types
     `track`, `photo` and `clip`. A movie gets a single-item queue and an
     episode a "continuous" one, so it cannot reproduce "play from here".
     It also needs the clicked item as a legacy entity. The new React
     library grid never registers its items in `appModel.get("entities")`
     (`metadataItems` stayed empty), which only holds servers and providers there.
   - `ui/player/playerLifecycle/queuePlayback` was **chosen**. With
     `options.playQueueID` (+ `options.type`, `options.next`) it fetches that
     existing queue, i.e. ours, and starts it unpaused. Caveat: if a player
     already holds a queue from the same provider, this action **appends**
     instead. The adapter therefore first runs the handlers for
     `ui/player/playerLifecycle/endPlayback` (`isForced`) and
     `ui/player/playerControls/resetAndClosePlayer`. Plex Web's batching
     helper runs those synchronously, so the reset is complete before the
     queue action reads the player state.
   - Player models live at `appModel.get("ui").get("audioVideoPlayer" | "photoPlayer")`,
     and the open queue is that model's `playQueue` attribute.
7. **More views and libraries (session 3).**
   - View styles: "Grid View", "Detail View", "Table View" (popup
     `data-testid="toolbarView"`). In Detail View a row's "More Actions"
     appears on hover. Table View has **no** "By …" sort popup: its column
     headers ("Title", "Year") are links that sort. Long lists render rows
     lazily as you scroll.
   - TV: a season page is `#!/server/<machineId>/details?key=%2Flibrary%2Fmetadata%2F<season>`
     and lists its episodes with `GET /library/metadata/<season>/children`. The
     show page lists seasons the same way.
   - Background queries: Plex Web also requests `/library/sections/<id>/all`
     for its recently-added hubs, with `contentDirectoryID` /
     `pinnedContentDirectoryID`. Such a request arriving after the grid's
     would have replaced the visible sort in our observer (a real bug, now
     filtered).
   - Other Videos libraries use the "Plex Video Files Scanner", which PMS
     only pairs with the legacy agent `com.plexapp.agents.none`. Their items
     are type `movie`.
8. **Play-queue windowing (PMS 1.43.5).** For 300 items, POST and GET
   `/playQueues` return a **window of 41** (20 before the selection, the
   selection, 20 after) with `playQueueTotalCount` 300; `window=N` widens it.
   Plex Web's own Next/Previous move across both window edges in the
   visible order (checked live by walking from offset 30 to 51 and back to 9
   with the player paused).

All anchors in `patches/play-from-here/plex-anchors.ts` are now `verified`
except the companion fallback (`api.companionPlayMedia`), which is never
needed while either native player path works.

9. **Autoplay across the window (session 4).** Unpaused, with 2-second
   clips, Plex Web's own autoplay started visible #30, #31, … #52 in order
   (23 items) after "Play from here" at #30. That carries playback past the
   first window's end (#50) with no gap, on both native player paths.
10. **Companion `playMedia` cannot reach Plex Web (session 4).** Forcing
    `pfh-player=companion` in the sandbox:
    `GET /player/playback/playMedia` with `X-Plex-Target-Client-Identifier`
    set to Plex Web's client id gets **404**, and `GET /clients` is empty
    while Plex Web is open (it only opens `/:/websockets/notifications`). In
    the bundle every `/player/...` path (`playMedia`, `skipNext`,
    `timeline/poll`, …) is a command Plex Web *sends* to other players, and
    `X-Plex-Provides` never occurs, so Plex Web never offers itself as a
    player. A claimed server is the only setup not tried (BACKLOG B5).

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
- The fallback patch selects the same module through the
  `.../queuePlayback` action string. It has the same replacement (both
  register the same getter) and captures the same handler map. Both
  patches form the group `play-from-here/player`. Preflight and the runtime
  report print `group play-from-here/player: active = …; standby = …`, and
  `pfh-player=primary|fallback|companion` forces a path.

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
- Session 3: the e2e grew to 6 tests: grid, Detail View, Table View, TV
  season page, Other Videos, and 300-item windowing. Every test checks the
  selected offset and the items on both sides of the clicked one. All 6
  passed in route mode (auto and forced fallback) and against the
  injector-applied install (default and `--opt pfh-player=fallback`).
- Sandbox notes: PMS merges byte-identical files into one item, so every
  generated file must differ. The Plex Movie scanner took about 17 minutes
  for 300 files, the Video Files scanner under 20 seconds. A fresh sandbox
  with a cached package starts in about 1m40s.

## Findings log

- 2026-10-31 (session 1): no bundle access in the build environment; nothing verified.
- 2026-10-31 (session 2): Plex Web 4.162.1 (PMS 1.43.5.11079) and 4.163.0
  (app.plex.tv) snapshotted; all anchors researched, replaced where wrong
  (`Add to Up Next`, `role=menu`), and verified by preflight plus a live run;
  native player adapter written; B3 and e2e pass against the sandbox PMS.
- 2026-10-31 (session 3): fallback player researched (`startPlayback`
  rejected, `queuePlayback` chosen) and verified live by forcing it; season
  pages, Detail/Table View, Other Videos and queue windowing verified; one
  observer bug (background hub queries) found and fixed; sandbox e2e added
  to CI.
- 2026-10-31 (session 4): autoplay across the queue window verified
  unpaused; companion fallback shown unusable with Plex Web (controller
  only; 404 from PMS); CI actions moved to their Node 24 majors.
- 2026-11-01 (session 5): Plex Web **4.160.0** (build `75ddd7b`), bundled
  with PMS 1.43.4.10903-e5521bd8c (package SHA-1 matched plex.tv's published
  checksum; extracted on a workstation, no server involved): preflight
  green. 208 JS files, 3,075 modules extracted; both player anchors resolve
  in one module, primary active, fallback on standby; menu labels present.
  Same location in the package (`Plug-ins-<build>/WebClient.bundle/...`).
  The derived-image patch stage (`image/apply-in-build.sh`) applied cleanly
  to it: `index.html` = original + one line. Export-capture shapes on 4.160.0
  are only checked at runtime: not live-verified yet (BACKLOG B4).
- 2026-11-01 (session 5, B4 first run): against a claimed PMS 1.43.4.10903
  (Plex Web 4.160.0) with a token, the e2e's `myPlexAccessToken` storage
  key works: Plex Web signs in as the token's account. That account is in a
  Plex Home, so a fresh profile stops at "Select User". In the 4.160.0
  bundle, the startup lock is skipped when the device setting `autoLogin`
  ("Automatically Sign In", stored as JSON under `deviceSettings`) is
  true; `e2e/auth.ts` now sets it. Unverified until the next run passes.
- 2026-11-01 (session 5, B4 second run): with `autoLogin`, the grid test
  **passed** on 4.160.0 against the claimed server (first live pass on
  4.160.0 and on a claimed server; runtime injected by interception). The
  other UI tests timed out choosing a sort: a real account remembers each
  library's sort and view style (synced across devices), so a fresh
  profile can open a library already sorted the requested way. Then the
  sort menu item is named "<label> Selected" (accessible name; an image
  "Selected") and the active Table View header "<label> Ascending" or
  "<label> Descending". The e2e now sorts differently first in that case,
  and sets the device setting `shouldSyncSettings` to false ("Turn off
  settings sync"; gates Plex Web's `POST /api/v2/user/settings`) so the
  tests' sorts and view styles stay out of the account. Unverified.
- 2026-11-01 (session 5, B4 third run): on 4.160.0 against the claimed
  server, grid, Detail View, Table View and the companion check **passed**.
  The sort-already-active handling worked ("<label> Selected" in the
  popup, "<label> Ascending/Descending" in Table View). Companion on a
  claimed server: PMS answers 404 to `playMedia` aimed at Plex Web and
  `/clients` stays empty, as in the sandbox, so `pfh-companion` now
  defaults to off (`api.companionPlayMedia` stays unverified: never seen
  working). Other Videos failed only in the test: Plex Web queued the whole
  2,641-item library (`playQueueTotalCount`), while the test's listing
  stopped at 500 items; it now pages through the whole listing.
- 2026-11-01 (session 5, B4 fourth run): on 4.160.0 against the claimed
  server, Other Videos **passed** with the paged listing: the queue held the
  whole 2,641-item library in the visible order, selected at the clicked
  item. An Other Videos library (agent `tv.plex.agents.none`) behaves like
  a movie library for "Play from here".
- 2026-11-01 (session 5, B4 fifth run): the full suite on 4.160.0 against
  the claimed server in one run: grid, Detail View, Table View, Other
  Videos and the companion check **passed** (TV and the 300-item tests not
  configured). `shouldSyncSettings` = false is **verified**: the owner had
  both test libraries sorted by Title in another browser, and after the
  run (which ends on Year and Date Added) they still sorted by Title with
  the same view style. B4 is done.
