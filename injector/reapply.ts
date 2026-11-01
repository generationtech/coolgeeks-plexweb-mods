/**
 * Apply / uninstall / status for the Plex Web injection. Idempotent: running
 * apply twice changes nothing the second time. Every write is preceded by a
 * pristine backup of index.html on the target.
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import type { PreflightResult } from "../preflight/preflight";
import { hasInjection, injectedVersion, injectTag, lineDiff, removeInjection, renderTag, RUNTIME_FILENAME } from "./html";
import { DEFAULT_SEARCH_ROOTS, PLEX_WEB_INDEX_SUFFIX, type InstallType, type TargetFs } from "./target-fs";

export const BACKUP_SUFFIX = ".plexweb-mods.orig";
/** Service-worker filenames that would serve a stale index.html (cache-busting check). */
export const SERVICE_WORKER_CANDIDATES = ["sw.js", "service-worker.js", "serviceworker.js"];

/** verify: HTTP-only check of what PMS serves against the local build; touches no filesystem (image installs). */
export type Mode = "apply" | "uninstall" | "status" | "snapshot" | "verify";

export interface ReapplyOptions {
  fs: TargetFs;
  mode: Mode;
  installType: InstallType;
  /** Directory containing Plex Web's index.html (on the target). Auto-discovered when empty. */
  webDir?: string;
  /** Local path of the built runtime (dist/plexweb-mods.js). */
  runtimePath: string;
  dryRun?: boolean;
  /** Apply even when preflight reports failures. */
  force?: boolean;
  skipPreflight?: boolean;
  banner?: boolean;
  reportDelayMs?: number;
  pluginOptions?: Record<string, string>;
  preflight?: (localDir: string) => PreflightResult;
  /** Chunk-global detection used when preflight is skipped. */
  detectChunkGlobals?: (localDir: string) => string[];
  formatPreflight?: (r: PreflightResult) => string;
  /** snapshot mode: local destination (must be inside a bundle-snapshots/ dir, which is gitignored). */
  snapshotDir?: string;
  /** Optional HTTP check of the served files (base URL of PMS). */
  verifyUrl?: string;
  fetchImpl?: (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string>; headers: { get(n: string): string | null } }>;
  log?: (line: string) => void;
}

export interface ReapplyResult {
  exitCode: 0 | 1 | 3;
  webDir?: string;
  changed: boolean;
  messages: string[];
}

export class ReapplyError extends Error {
  constructor(
    message: string,
    readonly exitCode: 1 | 3 = 1,
  ) {
    super(message);
    this.name = "ReapplyError";
  }
}

export function contentVersion(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

async function resolveWebDir(o: ReapplyOptions, say: (s: string) => void): Promise<string> {
  if (o.webDir) {
    if (!(await o.fs.exists(posix.join(o.webDir, "index.html")))) {
      throw new ReapplyError(`no index.html in PLEX_WEB_DIR=${o.webDir} on ${o.fs.describe()}`);
    }
    return o.webDir;
  }
  const found: string[] = [];
  for (const root of DEFAULT_SEARCH_ROOTS[o.installType]) found.push(...(await o.fs.findPlexWebIndex(root)));
  if (found.length === 0) {
    throw new ReapplyError(
      `could not find Plex Web (*/${PLEX_WEB_INDEX_SUFFIX}) under ${DEFAULT_SEARCH_ROOTS[o.installType].join(", ")} ` +
        `on ${o.fs.describe()}; set PLEX_WEB_DIR`,
    );
  }
  if (found.length > 1) throw new ReapplyError(`found several Plex Web copies, set PLEX_WEB_DIR to one of:\n  ${found.join("\n  ")}`);
  const dir = posix.dirname(found[0]!);
  say(`discovered Plex Web at ${dir}`);
  return dir;
}

export async function reapply(o: ReapplyOptions): Promise<ReapplyResult> {
  const messages: string[] = [];
  const say = (s: string) => {
    messages.push(s);
    o.log?.(s);
  };
  try {
    return await run(o, say, messages);
  } catch (err) {
    if (err instanceof ReapplyError) {
      say(`ERROR: ${err.message}`);
      return { exitCode: err.exitCode, changed: false, messages };
    }
    throw err;
  }
}

async function run(o: ReapplyOptions, say: (s: string) => void, messages: string[]): Promise<ReapplyResult> {
  if (o.mode === "verify") {
    if (!o.verifyUrl) throw new ReapplyError("verify needs PLEX_URL");
    const version = contentVersion(readRuntime(o.runtimePath));
    say(`checking what ${o.verifyUrl} serves against the local build (runtime version ${version})`);
    await verifyHttp(o, version, say);
    say("the served Plex Web carries this build");
    return { exitCode: 0, changed: false, messages };
  }
  const dry = o.dryRun ? "[dry-run] " : "";
  say(`target: ${o.fs.describe()} (${o.installType})`);
  const webDir = await resolveWebDir(o, say);
  const indexPath = posix.join(webDir, "index.html");
  const runtimeTarget = posix.join(webDir, RUNTIME_FILENAME);
  const backupPath = indexPath + BACKUP_SUFFIX;
  const html = await o.fs.readText(indexPath);
  const injected = hasInjection(html);

  if (o.mode === "status") {
    let local = "(not built)";
    try {
      local = contentVersion(readFileSync(o.runtimePath));
    } catch {
      /* not built */
    }
    say(`index.html: ${injected ? `injected (version ${injectedVersion(html) ?? "?"})` : "pristine (not injected)"}`);
    say(`runtime on target: ${(await o.fs.exists(runtimeTarget)) ? "present" : "absent"}; local build version: ${local}`);
    say(`backup: ${(await o.fs.exists(backupPath)) ? backupPath : "none"}`);
    if (injected && injectedVersion(html) !== local) say("note: injected version differs from the local build; run apply to update");
    return { exitCode: 0, webDir, changed: false, messages };
  }

  if (o.mode === "snapshot") {
    const dest = o.snapshotDir ?? "";
    if (!/(^|[\\/])bundle-snapshots[\\/]/.test(dest)) {
      throw new ReapplyError(`snapshot destination must be inside a bundle-snapshots/ directory (gitignored), got "${dest}"`);
    }
    if (existsSync(dest)) throw new ReapplyError(`snapshot destination already exists: ${dest}`);
    say(`${dry}copy ${webDir} (read-only) to ${dest}`);
    if (!o.dryRun) {
      const view = await o.fs.localView(webDir);
      cpSync(view, dest, { recursive: true });
      say(`snapshot written; it contains Plex's code: never commit it. Next: node dist/preflight.cjs --bundle-dir ${dest}`);
    }
    return { exitCode: 0, webDir, changed: false, messages };
  }

  await checkContainerFlags(o, say);

  if (o.mode === "uninstall") {
    if (!injected) {
      say("index.html is not injected; nothing to remove from it");
    } else {
      const restored = removeInjection(html);
      say(`${dry}remove the plexweb-mods block from ${indexPath}`);
      if (o.dryRun) say(lineDiff(html, restored));
      else await o.fs.writeText(indexPath, restored);
      if (await o.fs.exists(backupPath)) {
        const backup = await o.fs.readText(backupPath);
        if (backup === restored) {
          say(`${dry}index.html now matches the pristine backup; delete ${backupPath}`);
          if (!o.dryRun) await o.fs.remove(backupPath);
        } else {
          say(`note: restored index.html differs from ${backupPath} (Plex was probably updated since); backup kept`);
        }
      }
    }
    if (await o.fs.exists(runtimeTarget)) {
      say(`${dry}delete ${runtimeTarget}`);
      if (!o.dryRun) await o.fs.remove(runtimeTarget);
    }
    say(o.dryRun ? "dry-run complete; nothing was changed" : "uninstalled; hard-reload Plex Web (Ctrl+Shift+R) to drop the cached copy");
    return { exitCode: 0, webDir, changed: !o.dryRun && injected, messages };
  }

  // ---- apply ----------------------------------------------------------------
  const runtime = readRuntime(o.runtimePath);
  const version = contentVersion(runtime);
  say(`runtime ${o.runtimePath} (version ${version})`);

  let chunkGlobals: string[] = [];
  if (!o.skipPreflight && o.preflight) {
    const local = await o.fs.localView(webDir);
    const pf = o.preflight(local);
    chunkGlobals = pf.chunkGlobals;
    say(o.formatPreflight ? o.formatPreflight(pf) : `preflight: ${pf.ok ? "ok" : "FAILED"}`);
    if (!pf.ok) {
      if (!o.force) throw new ReapplyError("preflight failed; not applying. Fix the anchors, or re-run with --force to apply anyway.", 3);
      say("WARNING: preflight failed but --force was given; applying anyway (the runtime will report the failures loudly)");
    }
  } else {
    say("preflight skipped");
    if (o.detectChunkGlobals) chunkGlobals = o.detectChunkGlobals(await o.fs.localView(webDir));
  }
  say(`webpack chunk globals: ${chunkGlobals.join(", ") || "(none detected; relying on the Function.prototype.m hook)"}`);

  // 1. pristine backup
  const pristine = injected ? removeInjection(html) : html;
  const backupExists = await o.fs.exists(backupPath);
  if (!injected) {
    const stale = backupExists && (await o.fs.readText(backupPath)) !== html;
    if (!backupExists || stale) {
      if (stale) say("index.html changed since the last apply (Plex update?); refreshing the backup");
      say(`${dry}back up pristine index.html to ${backupPath}`);
      if (!o.dryRun) await o.fs.writeText(backupPath, html);
    } else {
      say(`backup ${backupPath} is current`);
    }
  } else if (!backupExists) {
    say(`${dry}no backup found; writing one from index.html minus the plexweb-mods block`);
    if (!o.dryRun) await o.fs.writeText(backupPath, pristine);
  }

  // 2. runtime file
  let changed = false;
  const targetRuntime = (await o.fs.exists(runtimeTarget)) ? await o.fs.readText(runtimeTarget) : null;
  if (targetRuntime !== null && contentVersion(targetRuntime) === version) {
    say(`${runtimeTarget} is up to date`);
  } else {
    say(`${dry}copy runtime to ${runtimeTarget}`);
    if (!o.dryRun) await o.fs.copyIn(o.runtimePath, runtimeTarget);
    changed = true;
  }

  // 3. index.html (the ?v=<content hash> query is the cache-busting step)
  const tag = renderTag({
    version,
    chunkGlobals,
    ...(o.banner !== undefined ? { banner: o.banner } : {}),
    ...(o.reportDelayMs !== undefined ? { reportDelayMs: o.reportDelayMs } : {}),
    ...(o.pluginOptions ? { options: o.pluginOptions } : {}),
  });
  const next = injectTag(html, tag);
  if (!next.changed) {
    say("index.html already carries this exact injection");
  } else {
    say(`${dry}${next.position === "replaced" ? "update" : "insert"} script tag in ${indexPath} (${next.position})`);
    if (o.dryRun) say(lineDiff(html, next.html));
    else await o.fs.writeText(indexPath, next.html);
    changed = true;
  }

  // 4. verify what is on the target now
  if (!o.dryRun) {
    const after = await o.fs.readText(indexPath);
    if (injectedVersion(after) !== version) throw new ReapplyError(`verification failed: ${indexPath} does not reference version ${version}`);
    const rt = await o.fs.readText(runtimeTarget);
    if (contentVersion(rt) !== version) throw new ReapplyError(`verification failed: ${runtimeTarget} content does not match the build`);
    say(`verified: index.html references ${RUNTIME_FILENAME}?v=${version} and the runtime file matches`);
  }

  // 5. cache-busting checks
  for (const sw of SERVICE_WORKER_CANDIDATES) {
    if (await o.fs.exists(posix.join(webDir, sw))) {
      say(`WARNING: ${sw} exists in the Plex Web dir; a service worker may serve a cached index.html until it updates`);
    }
  }
  if (o.verifyUrl && !o.dryRun) await verifyHttp(o, version, say);

  say(
    o.dryRun
      ? "dry-run complete; nothing was changed"
      : changed
        ? "applied. Hard-reload Plex Web once (Ctrl+Shift+R) so the browser fetches the new index.html."
        : "already applied and up to date; nothing changed",
  );
  return { exitCode: 0, webDir, changed, messages };
}

function readRuntime(path: string): Buffer {
  try {
    return readFileSync(path);
  } catch {
    throw new ReapplyError(`runtime not built: ${path} (run npm run build)`);
  }
}

/** Where to send people whose container cannot be changed in place. */
export const DERIVED_IMAGE_HINT = 'bake the mods into a derived image instead: see "Container installs" in README.md (image/Containerfile)';

/**
 * Apply and uninstall write into the container. A read-only root fs makes
 * that fail (refuse up front, with the way out); --rm makes it short-lived.
 */
async function checkContainerFlags(o: ReapplyOptions, say: (s: string) => void): Promise<void> {
  const flags = o.fs.containerFlags ? await o.fs.containerFlags() : null;
  if (!flags) return;
  if (flags.readOnly) {
    const what = `${o.fs.describe()} has a read-only root filesystem, so Plex Web cannot be changed in place; ${DERIVED_IMAGE_HINT}`;
    if (!o.dryRun) throw new ReapplyError(what);
    say(`WARNING: ${what}`);
  }
  if (flags.autoRemove && o.mode === "apply") {
    say(`note: ${o.fs.describe()} runs with --rm, so it is recreated from its image on every start and loses this change; to keep it, ${DERIVED_IMAGE_HINT}`);
  }
}

async function verifyHttp(o: ReapplyOptions, version: string, say: (s: string) => void): Promise<void> {
  const f = o.fetchImpl ?? ((u: string) => fetch(u, { cache: "no-store" }));
  const base = o.verifyUrl!.replace(/\/+$/, "");
  const idx = await f(`${base}/web/index.html`);
  const body = idx.ok ? await idx.text() : "";
  if (!idx.ok || !body.includes(`${RUNTIME_FILENAME}?v=${version}`)) {
    throw new ReapplyError(`HTTP verify: ${base}/web/index.html (HTTP ${idx.status}) does not reference ${RUNTIME_FILENAME}?v=${version}`);
  }
  say(`HTTP verify: index.html served with the new tag (Cache-Control: ${idx.headers.get("cache-control") ?? "none"})`);
  const rt = await f(`${base}/web/${RUNTIME_FILENAME}?v=${version}`);
  if (!rt.ok || contentVersion(await rt.text()) !== version) {
    throw new ReapplyError(`HTTP verify: ${base}/web/${RUNTIME_FILENAME} not served correctly (HTTP ${rt.status})`);
  }
  say("HTTP verify: runtime served and matches the build");
}
