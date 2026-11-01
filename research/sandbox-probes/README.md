# Sandbox probes (historical)

One-off Playwright and fetch scripts from sessions 2–4, kept as a record
of how the findings in `docs/anchor-research.md` were reached. They run
**only against the local sandbox** (`scripts/sandbox-pms.sh start`,
`http://127.0.0.1:32400`, unclaimed, no token). The e2e suite
(`e2e/`) now covers everything they checked; prefer it.

They are kept as they ran, with three edits: paths are relative to the
repo (they used to be absolute container paths), two broken string
literals in `ui3.mjs` are repaired, and an unused helper in `ui4.mjs` is
renamed. Section ids (`source=1`, `/library/sections/4`) and rating keys
are the sandbox's ids at the time and may differ in a fresh sandbox; look
them up with `scripts/sandbox-pms.sh env`.

```sh
npm ci && npm run build                  # probes load dist/plexweb-mods.js and @playwright/test
eval "$(scripts/sandbox-pms.sh start)"
mkdir -p /tmp/probe-out
node research/sandbox-probes/ui5.mjs /tmp/probe-out        # screenshots land in the given dir
node research/sandbox-probes/fb.mjs fallback /tmp/probe-out
npx esbuild research/sandbox-probes/b3.ts --bundle --platform=node --format=esm --outfile=/tmp/probe-out/b3.mjs && node /tmp/probe-out/b3.mjs
```

| Script | What it checked | Now covered by |
| --- | --- | --- |
| `b3.ts` | B3 against PMS directly: `POST /playQueues` with a sorted (and a filtered) section `uri` plus `key` returns the sorted order from the item on | e2e "queue follows the visible sort" tests |
| `ui1.mjs` | Plex Web loads from an unclaimed localhost PMS without an account; which requests it makes | e2e `setup` |
| `ui2.mjs` | library listing requests (`/library/sections/<id>/all`), item link shape, card structure | e2e listing tracking |
| `ui3.mjs` | grid DOM order, the card's "More Actions" button and menu, the sort menu, the listing after a sort | `e2e/ui.ts` |
| `ui4.mjs` | DOM ancestry of "Play Next" in the item menu and of the sort menu items | `dom.*` anchors in `plex-anchors.ts` |
| `ui5.mjs` | first end-to-end "Play from here" with the runtime injected: menu entry, player opens, anchor report status | e2e grid test |
| `ui6.mjs` | the `uri` Plex Web's own library Play button sends (same `uri`, no `key`) | README STATUS "PMS API" |
| `ui7.mjs` | TV show → season navigation and its listing requests; the view-style menu | e2e TV test |
| `ui8.mjs` | Detail View and Table View: row structure, DOM order, "More Actions" on hover | e2e Detail/Table tests |
| `tbl.mjs` | Table View: column header sorting, row "More Actions", the tracked listing | e2e Table View test |
| `fb.mjs` | forced player path (`primary`/`fallback`): queue POST, active path, a second play replaces the queue | e2e with `PLEX_E2E_PLAYER=fallback` |
| `win.mjs` | 300-item library: Next/Previous across the queue window edges | e2e "300 items" windowing test |
| `comp.mjs` | forced companion path: `playMedia` answer, PMS `/clients`, websockets Plex Web opens | e2e companion test |

Same rules as the rest of the repo: no tokens, no real server URLs, no
media titles, no Plex code. Output from these scripts (DOM ancestry,
screenshots) stays local.
