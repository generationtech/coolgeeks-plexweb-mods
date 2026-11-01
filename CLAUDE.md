# CLAUDE.md — standing rules for every session

This repo holds runtime mods for a self-hosted Plex Web client (the copy that
Plex Media Server serves at `:32400/web`). The mods must be re-appliable after
every PMS update. Read this file fully before changing anything.

## Non-negotiable rules

1. **This is a PUBLIC repo under the MIT license.** Never commit:
   - secrets, tokens, passwords, API keys (Plex tokens included);
   - hostnames, IP addresses, `*.plex.direct` names, URLs of the owner's
     servers, or anything else that maps the owner's network;
   - library names, media titles from the owner's libraries, usernames;
   - machine identifiers, client identifiers, library section UUIDs;
   - Plex's own code. No copied functions, no code excerpts, no bundle
     files, no minified snippets, no screenshots of bundle source.
   The **only** Plex-derived content allowed is short anchor strings: a few
   words, localization keys, API paths (e.g. `"Play Next"`, `/playQueues`).
   Captured Plex Web bundles live only in the gitignored `bundle-snapshots/`.
   Owner- and homelab-specific material (server notes, copies of container
   definitions, research helpers that print bundle code) lives only in the
   gitignored `local/`. The pre-commit hook and a gitleaks rule refuse any
   path under `local/`, even when force-added.
2. **All configuration comes from environment variables.** Only
   `.env.example` (placeholders only) is committed. Real values go in a local
   `.env`, which is gitignored. Tests and fixtures use obvious placeholders
   (`test-machine-identifier`, `test-token`), never real-looking values.
3. **Commit small and often** with Conventional Commit messages
   (`feat:`, `fix:`, `test:`, `docs:`, `chore:`, `ci:`, `refactor:`).
4. **Push to `main` after each green step.** If the session harness assigns a
   designated working branch, push to that branch instead and leave merging to
   the owner. **Never force-push. Never rewrite published history** (no
   `rebase` of pushed commits, no `commit --amend` after push, no
   `reset --hard` onto an older remote state).
5. **Before every commit: run gitleaks and the test suite; never commit red.**
   The pre-commit hook (`.githooks/pre-commit`, installed by `npm install`
   via the `prepare` script) does this: `gitleaks git --pre-commit --staged`,
   `npm run lint`, `npm test`. Do not bypass it with `--no-verify`.
6. **Server-dependent work goes to `BACKLOG.md`**, written so that a future
   session (or the owner) can execute it without asking questions: exact
   commands, which env vars they need, and the expected result.
7. **Keep `BACKLOG.md` and the `STATUS` section of `README.md` current.**
   Update both in the same commit as the work that changes them.

## Working style

- Work autonomously ("dark factory"). The owner is often away from the
  homelab; do not block on questions. If something needs the real server,
  write it up in `BACKLOG.md` and move on.
- Prefer the smallest change that keeps the suite green; add tests with
  every behavior change.
- Anything Plex-coupled (bundle anchors, DOM selectors, route patterns,
  storage keys) lives in one place per mod (see
  `patches/play-from-here/plex-anchors.ts`) and is marked `verified` or
  `unverified`. Promote an anchor to `verified` only after preflight or e2e
  proved it against a real bundle, and note the Plex Web version in
  `docs/anchor-research.md`.

## Tooling quick reference

| Task                          | Command                                         |
| ----------------------------- | ----------------------------------------------- |
| Install deps + git hook       | `npm ci` (runs `prepare` → sets `core.hooksPath`) |
| Lint + typecheck              | `npm run lint`                                  |
| Unit tests (no server needed) | `npm test`                                      |
| Build all outputs to `dist/`  | `npm run build`                                 |
| Scan history for secrets      | `npm run secrets`                               |
| Anchor preflight (read-only)  | `npm run preflight -- --bundle-dir <dir>`       |
| Apply / dry-run / uninstall   | `./injector/reapply.sh [--dry-run\|--uninstall]` |
| E2E (needs a real server)     | `npm run test:e2e` (skips when `PLEX_URL` unset) |
| Local throwaway PMS for e2e   | `scripts/sandbox-pms.sh start` (unclaimed, localhost-only, no account) |

gitleaks is a standalone binary (not an npm package). Install a release from
<https://github.com/gitleaks/gitleaks/releases> or, if GitHub release
downloads are blocked, `go install github.com/zricethezav/gitleaks/v8@v8.30.1`.

## Layout

- `runtime/` — browser runtime: webpack hook loader + string-anchored patch
  engine (Vencord-style) + anchor report.
- `patches/<mod>/` — one directory per mod: patch definitions (anchors),
  pure logic, and the Plex-coupled bindings behind a small interface.
- `injector/` — the reapply tool (Node + `reapply.sh` wrapper). Linux package
  and Docker installs. Idempotent; dry-run, backup, uninstall.
- `preflight/` — read-only anchor resolution report against a bundle dir
  (`--find <text>` for research: module ids only, never code).
- `tools/` — snapshot of a public Plex Web URL into `bundle-snapshots/`.
- `scripts/sandbox-pms.sh` — throwaway unclaimed PMS (latest Linux package,
  extracted, `allowedNetworks` = localhost, ffmpeg test videos) for B3-style
  curl tests and the e2e. Never sign it in or use an account token.
- `test/` — unit tests with synthetic fake webpack bundles; `e2e/` —
  Playwright tests against a real server (skipped without `PLEX_URL`).
- `docs/` — research notes (anchor strings only, never code excerpts).
- `local/` — gitignored, owner-only (homelab notes, local tools). Never
  committed; write real hostnames, paths and image names here or in `.env`.
