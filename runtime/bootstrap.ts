/**
 * Wires everything together in the page: config -> patch session -> webpack
 * hooks -> plugin init (immediately) -> plugin start (DOM ready) -> anchor
 * report (after load), failing loudly when a required anchor is unresolved.
 */
import { formatReport, PatchSession, type PatchReport } from "./engine";
import { installWebpackHooks, type WebpackHooks } from "./loader";
import { showBanner, showToast } from "./ui";
import type { Logger, PluginApi, PluginDef, RuntimeConfig } from "./types";

export const GLOBAL_NAME = "__plexwebMods";

export interface ModsHandle {
  version: string;
  config: RuntimeConfig;
  plugins: Record<string, PluginDef>;
  session: PatchSession;
  hooks: WebpackHooks;
  /** Current anchor report (pass {final:true} to evaluate unresolved anchors). */
  report(opts?: { final?: boolean }): PatchReport;
  printReport(opts?: { final?: boolean }): string;
  status: "starting" | "ok" | "anchor-failure";
}

export function createLogger(debug: boolean, con: Pick<Console, "debug" | "info" | "warn" | "error"> = console): Logger {
  const p = "[plexweb-mods]";
  return {
    debug: (...a) => debug && con.debug(p, ...a),
    info: (...a) => con.info(p, ...a),
    warn: (...a) => con.warn(p, ...a),
    error: (...a) => con.error(p, ...a),
  };
}

export interface BootstrapOptions {
  target: any;
  plugins: readonly PluginDef[];
  config: RuntimeConfig;
  version: string;
  log?: Logger;
}

export function bootstrap(opts: BootstrapOptions): ModsHandle | null {
  const { target, plugins, config } = opts;
  const log = opts.log ?? createLogger(config.debug);
  if (target[GLOBAL_NAME]) {
    log.warn("loaded twice; keeping the first instance");
    return null;
  }
  const doc: Document | undefined = target.document;

  const session = new PatchSession(plugins, {
    selfExpr: (name) => `globalThis.${GLOBAL_NAME}.plugins[${JSON.stringify(name)}]`,
    onIssue: (issue) => (issue.optional ? log.warn(issue.message) : log.error(issue.message)),
  });

  const handle = {
    version: opts.version,
    config,
    plugins: Object.fromEntries(plugins.map((p) => [p.name, p])),
    session,
    status: "starting",
  } as ModsHandle;
  handle.report = (o) => session.report(o);
  handle.printReport = (o) => {
    const text = formatReport(session.report(o));
    log.info(`\n${text}`);
    return text;
  };
  Object.defineProperty(target, GLOBAL_NAME, { value: handle, configurable: true, enumerable: false, writable: false });

  handle.hooks = installWebpackHooks({ session, target, chunkGlobals: config.chunkGlobals, log });

  const api: PluginApi = {
    mods: handle,
    log,
    config,
    notify: (m, level) => showToast(doc, `plexweb-mods: ${m}`, level),
  };
  for (const p of plugins) {
    try {
      p.init?.(api);
    } catch (err) {
      log.error(`plugin ${p.name} init failed`, err);
    }
  }

  const onReady = () => {
    handle.hooks.scanForChunkGlobals();
    for (const p of plugins) {
      Promise.resolve()
        .then(() => p.start?.(api))
        .catch((err) => log.error(`plugin ${p.name} start failed`, err));
    }
  };
  if (!doc || doc.readyState !== "loading") onReady();
  else doc.addEventListener("DOMContentLoaded", onReady, { once: true });

  const finalCheck = () => {
    const report = session.report({ final: true });
    handle.status = report.ok ? "ok" : "anchor-failure";
    doc?.documentElement?.setAttribute("data-plexweb-mods-status", handle.status);
    if (report.ok) {
      log.info(`anchors OK (${report.entries.length} patches, ${report.modulesSeen} modules scanned, ${report.warnings.length} warnings)`);
      if (config.debug) log.info(`\n${formatReport(report)}`);
      return;
    }
    log.error(`required anchors failed; affected mods are inactive.\n${formatReport(report)}`);
    target.dispatchEvent?.(new target.CustomEvent("plexweb-mods:anchor-failure", { detail: report }));
    if (config.banner) {
      const ids = [...new Set(report.failures.map((f) => f.patchId))].join(", ");
      showBanner(doc, `plexweb-mods: ${report.failures.length} anchor failure(s) in ${ids}. Open the browser console for details.`);
    }
  };
  const schedule = () => setTimeout(finalCheck, config.reportDelayMs);
  if (doc?.readyState === "complete") schedule();
  else target.addEventListener?.("load", schedule, { once: true });

  return handle;
}
