# Synthetic fake webpack bundles

Hand-written for this repo's tests. They imitate the *shape* of webpack 4 and
webpack 5 production output (module tables, `__webpack_require__.m`, chunk
loading globals, method-shorthand factories) so the loader, patch engine and
preflight can be exercised without a Plex bundle. They contain no Plex code;
the strings "Play Next" / "Add to Up Next" stand in for anchor candidates.

- `wp5/` — runtime with inline modules, one chunk pushed *before* the runtime
  (as with ordered script tags), one lazy chunk pushed *after* it.
  Chunk global: `webpackChunkfake_plex`.
- `wp4/` — classic `webpackJsonp` runtime whose jsonp callback copies chunk
  modules into a private table (strategy B is mandatory there).
- `wp5-plex-shape/` — the *shape* verified in Plex Web 4.162.1 (see
  docs/anchor-research.md), written from scratch: a service registry, a module
  that looks up `"appModel"` through it and exports an action-handler map keyed
  by the "start existing play queue" action type, and a menu-label module. Lets
  the play-from-here patches resolve, apply and run end to end in tests.
