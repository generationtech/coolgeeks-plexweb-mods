import { describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bootstrap, createLogger, GLOBAL_NAME } from "../runtime/bootstrap";
import { DEFAULT_CONFIG, parseConfig } from "../runtime/config";
import type { PluginDef, RuntimeConfig } from "../runtime/types";
import { bundleFixture } from "./helpers/realm";

const root = join(import.meta.dirname, "..");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function page() {
  return new JSDOM(`<!DOCTYPE html><html><head></head><body><div id="plex"></div></body></html>`, {
    url: "https://plex-server.example:32400/web/index.html",
    runScripts: "outside-only",
  });
}

function capturingLogger() {
  const lines: Record<"debug" | "info" | "warn" | "error", string[]> = { debug: [], info: [], warn: [], error: [] };
  const con = Object.fromEntries((["debug", "info", "warn", "error"] as const).map((k) => [k, (...a: unknown[]) => lines[k].push(a.map(String).join(" "))]));
  return { lines, log: createLogger(true, con as any) };
}

const cfg = (over: Partial<RuntimeConfig> = {}): RuntimeConfig => ({ ...DEFAULT_CONFIG, reportDelayMs: 0, ...over });

describe("parseConfig", () => {
  it("reads chunk globals, delay, banner, debug and plugin options from data-* attributes", () => {
    const c = parseConfig({
      chunkGlobals: "webpackChunkplex_web, bad-name!, webpackChunkplex_web",
      reportDelayMs: "2500",
      banner: "off",
      optPfhCompanion: "off",
      optPfhDropParams: "includeCollections",
    });
    expect(c.chunkGlobals).toEqual(["webpackJsonp", "webpackChunkplex_web"]);
    expect(c.reportDelayMs).toBe(2500);
    expect(c.banner).toBe(false);
    expect(c.debug).toBe(false);
    expect(c.options).toEqual({ "pfh-companion": "off", "pfh-drop-params": "includeCollections" });
  });

  it("falls back to defaults and honours the localStorage debug override", () => {
    const c = parseConfig({ reportDelayMs: "soon" }, "1");
    expect(c.reportDelayMs).toBe(DEFAULT_CONFIG.reportDelayMs);
    expect(c.banner).toBe(true);
    expect(c.debug).toBe(true);
  });
});

describe("bootstrap", () => {
  const required: PluginDef = {
    name: "needs-anchor",
    description: "",
    patches: [{ id: "needs-anchor/x", find: "string that is nowhere", replacements: [{ match: "a", replace: "b" }] }],
  };

  it("fails loudly and specifically when a required anchor is unresolved", async () => {
    const dom = page();
    const { lines, log } = capturingLogger();
    const events: unknown[] = [];
    dom.window.addEventListener("plexweb-mods:anchor-failure", (e) => events.push((e as CustomEvent).detail));
    const handle = bootstrap({ target: dom.window, plugins: [required], config: cfg(), version: "test", log })!;
    dom.window.eval(readFileSync(bundleFixture("wp5", "js", "vendor.js"), "utf8"));
    dom.window.eval(readFileSync(bundleFixture("wp5", "js", "main.js"), "utf8"));
    await wait(50);
    expect(handle.status).toBe("anchor-failure");
    expect(dom.window.document.documentElement.getAttribute("data-plexweb-mods-status")).toBe("anchor-failure");
    expect(lines.error.join("\n")).toMatch(/\[needs-anchor\/x\] FIND_UNRESOLVED: find anchor\(s\) "string that is nowhere" occurred in no module \(scanned \d+ modules\)/);
    expect(events).toHaveLength(1);
    expect(dom.window.document.querySelector("[data-plexweb-mods-banner]")?.textContent).toMatch(/1 anchor failure\(s\) in needs-anchor\/x/);
  });

  it("reports OK, runs init before Plex and start on DOM ready, and exposes $self", async () => {
    const dom = page();
    const { lines, log } = capturingLogger();
    const order: string[] = [];
    const plugin = {
      name: "ok-plugin",
      description: "",
      seen: [] as string[],
      patches: [{ id: "ok-plugin/menu", find: '"Add to Up Next"', replacements: [{ match: '"Add to Up Next"', replace: '"Add to Up Next",$self.mark()' }] }],
      mark() {
        order.push("patched code ran");
        return "Play from here";
      },
      init: () => void order.push("init"),
      start: () => void order.push("start"),
    };
    const handle = bootstrap({ target: dom.window, plugins: [plugin], config: cfg({ chunkGlobals: ["webpackChunkfake_plex"] }), version: "test", log })!;
    expect(order).toEqual(["init"]);
    dom.window.eval(readFileSync(bundleFixture("wp5", "js", "vendor.js"), "utf8"));
    dom.window.eval(readFileSync(bundleFixture("wp5", "js", "main.js"), "utf8"));
    await wait(50);
    expect((dom.window as any).__bootResult).toBe("booted:Play Next|Add to Up Next|Play from here");
    expect(order[0]).toBe("init");
    expect(order).toEqual(expect.arrayContaining(["start", "patched code ran"]));
    expect(handle.status).toBe("ok");
    expect(lines.info.join("\n")).toMatch(/anchors OK \(1 patches/);
    expect(dom.window.document.querySelector("[data-plexweb-mods-banner]")).toBeNull();
    expect(handle.printReport({ final: true })).toMatch(/OK {3}ok-plugin\/menu/);
  });

  it("refuses to load twice", () => {
    const dom = page();
    const { lines, log } = capturingLogger();
    expect(bootstrap({ target: dom.window, plugins: [], config: cfg(), version: "1", log })).not.toBeNull();
    expect(bootstrap({ target: dom.window, plugins: [], config: cfg(), version: "2", log })).toBeNull();
    expect(lines.warn.join()).toMatch(/loaded twice/);
    expect((dom.window as any)[GLOBAL_NAME].version).toBe("1");
  });
});

describe("bundled runtime (dist/plexweb-mods.js) smoke test", () => {
  async function bootBundled(fixture: string, files: string[]) {
    const out = await build({
      entryPoints: [join(root, "runtime/entry.ts")],
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      target: ["es2020"],
      define: { __PLEXWEB_MODS_VERSION__: '"test"' },
      logLevel: "silent",
    });
    const dom = page();
    const script = dom.window.document.createElement("script");
    script.dataset.chunkGlobals = "webpackChunkfake_plex";
    script.dataset.reportDelayMs = "0";
    Object.defineProperty(dom.window.document, "currentScript", { get: () => script, configurable: true });
    dom.window.eval(out.outputFiles[0]!.text);
    for (const f of files) dom.window.eval(readFileSync(bundleFixture(fixture, "js", f), "utf8"));
    await wait(50);
    return dom;
  }

  it("boots ahead of a webpack bundle without breaking it, and fails loudly when the player module is absent", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const dom = await bootBundled("wp5", ["vendor.js", "main.js"]);
      const mods = (dom.window as any).__plexwebMods;
      expect(mods.version).toBe("test");
      expect(mods.config.chunkGlobals).toContain("webpackChunkfake_plex");
      expect(Object.keys(mods.plugins)).toEqual(["play-from-here"]);
      expect((dom.window as any).__bootResult).toBe("booted:Play Next|Add to Up Next");
      expect(mods.plugins["play-from-here"].tracker).not.toBeNull();
      expect(mods.status).toBe("anchor-failure");
      const report = mods.report({ final: true });
      expect(report.failures.map((f: any) => `${f.patchId}:${f.code}`)).toEqual([
        "play-from-here/native-player:FIND_UNRESOLVED",
        "play-from-here/native-player-fallback:FIND_UNRESOLVED",
      ]);
      expect(report.groups[0].active).toBeNull();
      expect(consoleError.mock.calls.flat().join(" ")).toMatch(/\[play-from-here\/native-player\] FIND_UNRESOLVED/);
    } finally {
      consoleError.mockRestore();
      consoleInfo.mockRestore();
    }
  });

  it("reports OK on a Plex-shaped bundle and captures the native player", async () => {
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const dom = await bootBundled("wp5-plex-shape", ["main.js"]);
      const mods = (dom.window as any).__plexwebMods;
      expect(mods.report({ final: true }).failures).toEqual([]);
      expect(mods.status).toBe("ok");
      const pfh = mods.plugins["play-from-here"];
      expect(typeof pfh.native.getAppModel).toBe("function");
      expect(Object.keys(pfh.native.handlers)).toContain("ui/player/playerLifecycle/startExistingPlayQueuePlayback");
      expect(pfh.nativeFallback.handlers).toBe(pfh.native.handlers); // same handler map, captured by both patches
      expect(pfh.activePath()).toEqual({ path: "native" });
      expect(pfh.diagnostics.contextMenuModules).toEqual(["700"]);
    } finally {
      consoleInfo.mockRestore();
    }
  });
});
