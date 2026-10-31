# Anchor research: Plex Web

Findings about Plex Web internals that the mods depend on. **Anchor strings
only**: short strings, localization keys, API paths, module ids. Never code
excerpts, never bundle files (those stay in the gitignored
`bundle-snapshots/`).

## Status (2026-10-31): blocked in the build environment, nothing verified yet

| Attempt | Result |
| --- | --- |
| `node dist/fetch-plex-web.cjs --url https://app.plex.tv/desktop/` | failed: the sandbox's egress proxy rejected the CONNECT to `app.plex.tv:443` (HTTP 403, policy denial) |
| `curl https://app.plex.tv/desktop/index.html` | same 403 |
| `plex.tv`, `downloads.plex.tv`, `watch.plex.tv` | same 403 (no PMS package download either) |

So in this environment there is no Plex Web bundle to examine. Nothing in
`patches/play-from-here/plex-anchors.ts` is verified; every bundle, DOM
and route anchor is marked `unverified`. The research is BACKLOG item B4.

What was validated instead, without Plex:

- The loader and patch engine work against hand-written webpack 4/5 bundles
  **and** against genuine webpack 5 production output (minified, runtime
  chunk, split chunk, lazy chunk loaded through webpack's own script
  loader), with and without the chunk-global name known in advance
  (`test/loader.test.ts`, `test/real-webpack.test.ts`).
- Preflight extracts modules from that real webpack output and resolves
  anchors in it (`test/preflight.test.ts`).
- Preflight against the synthetic fixture (`test/fixtures/bundles/wp5`)
  shows the expected result: the context-menu candidate resolves, the
  native-player candidate does not, and the native-player patch is
  `PATCH_INCOMPLETE` in any case (see below).

## What the mods need from Plex Web

| Need | How it is met now | Plex-coupled anchor (all in `plex-anchors.ts`) | Status |
| --- | --- | --- | --- |
| Which listing is on screen (section, sort, filters) | observe Plex Web's own `GET /library/sections/<id>/all?...` requests (fetch/XHR) | `api.sectionListingPath` | documented PMS API |
| Machine identifier | `GET /identity`; route as fallback | `api.identity`, `routes.*` | documented / unverified |
| Which item was picked | DOM: smallest ancestor of the clicked element holding exactly one detail link | `dom.itemLinkSelector`, `dom.itemKeyPattern` | unverified |
| Menu entry | DOM: clone the "Play Next" entry of an opened `[role=menu]` | `dom.menu*` | unverified |
| Create the queue | `POST /playQueues` with `uri` = sorted section listing, `key` = item, `shuffle=0` | `api.playQueues` | documented PMS API, request shape unverified (B3) |
| Start Plex Web's player | bundle export capture → `registerNativePlayer()`; fallback: companion `playMedia` to this client | `bundle.nativePlayerModule`, `api.companionPlayMedia` | unverified; adapter not written (`todo`) |
| Context-menu module (diagnostics, future bundle-level menu patch) | export capture, optional | `bundle.contextMenuModule` | unverified |

Current anchor list (from `node dist/preflight.cjs --anchors`):

```text
unverified bundle.contextMenuModule   Play Next + Add to Up Next
unverified bundle.nativePlayerModule  playQueueSelectedItemID + /playQueues
unverified dom.menuSelector           [role="menu"]
unverified dom.menuItemSelector       [role="menuitem"]
unverified dom.menuAnchorLabels       Play Next + Add to Up Next
unverified dom.itemLinkSelector       a[href*="%2Flibrary%2Fmetadata%2F"]
unverified dom.itemKeyPattern         /key=%2Flibrary%2Fmetadata%2F(\d+)/
unverified routes.libraryListing      #!/media/<machineId>/com.plexapp.plugins.library?...source=<sectionId>
unverified routes.serverScoped        #!/(media|server)/<machineId>/
documented api.sectionListingPath     /library/sections/<id>/all
documented api.playQueues             /playQueues
documented api.identity               /identity
unverified api.companionPlayMedia     /player/playback/playMedia
```

## Open research questions (B4) and how to answer each

Get a complete bundle first. The server's own copy is complete (every lazy
chunk is on disk); a URL snapshot only has what `index.html` references.

```sh
./injector/reapply.sh --snapshot          # -> bundle-snapshots/<type>-<timestamp>/
SNAP=bundle-snapshots/<that dir>
```

1. **Is it webpack-built? Which chunk global?**
   `node dist/preflight.cjs --bundle-dir "$SNAP"` prints `chunk globals:` and
   the number of modules extracted. Expect one `webpackChunk<name>` global
   and thousands of modules. Record the global name and module count below.
   If no module tables are found, the extractor or the assumption is wrong:
   stop and write that down.
2. **Does the library Play button send a sorted `uri`?** Easiest in the
   browser: open a library, change the sort, press the library's Play (or
   Shuffle) button, and read the `uri` param of `POST /playQueues` in
   DevTools > Network. Record only the shape (scheme, path, which params),
   with ids replaced by placeholders. In the bundle:
   `node dist/preflight.cjs --bundle-dir "$SNAP" --find /playQueues --find shuffle`
   lists the module ids involved.
3. **Item context-menu definitions near "Play Next" / "Add to Up Next".**
   `node dist/preflight.cjs --bundle-dir "$SNAP" --find "Play Next" --find "Add to Up Next"`
   shows which modules contain each label and which contain both. If the
   labels are localization keys rather than literals, search for the key
   form you find in the strings table and record it here.
4. **Native player entry point.** With the runtime loaded (e2e route mode,
   or after a forced apply), open DevTools and inspect
   `__plexwebMods.plugins["play-from-here"].diagnostics.nativePlayerCandidates`
   (module ids plus export names of every module matching the candidate
   anchors), then `--find` player-specific strings in the snapshot to narrow
   it to one module. Then:
   - set `bundle.nativePlayerModule` to anchors that select exactly that
     module (preflight must show 1 module, not `FIND_AMBIGUOUS`);
   - write the adapter in `createPatches()` (`onExports` builds a
     `NativePlayer`, calls `registerNativePlayer`, returns `true`);
   - remove the `todo` from the native-player patch.
5. **DOM and routes.** Confirm `routes.libraryListing` against the address
   bar of a library page, `dom.itemLinkSelector` against a poster card, and
   the menu roles/labels against an opened item menu (DevTools > Elements).
   Promote each to `verified` with the Plex Web version.

## Findings log

Append one entry per research session: date, Plex Web version (from the
hashed script names in `index.html` or the About screen), what was verified,
anchor strings only.

- 2026-10-31: no bundle access (see Status). Nothing verified.
