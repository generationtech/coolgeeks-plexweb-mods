import { beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractModulesFromSource, scanBundleDir } from "../preflight/extract";
import { formatPreflight, runPreflight } from "../preflight/preflight";
import type { PluginDef } from "../runtime/types";
import { bundleFixture } from "./helpers/realm";
import { buildRealWebpackApp } from "./helpers/webpack-build";

const root = join(import.meta.dirname, "..");
const plugin = (patches: PluginDef["patches"]): PluginDef => ({ name: "t", description: "", patches });

function dirHash(dir: string): string {
  const h = createHash("sha256");
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else h.update(`${p}:${st.mtimeMs}:${st.size}:`).update(readFileSync(p));
    }
  };
  walk(dir);
  return h.digest("hex");
}

describe("extractModulesFromSource", () => {
  it("extracts webpack 5 chunk modules including method shorthand", () => {
    const r = extractModulesFromSource(readFileSync(bundleFixture("wp5", "js", "vendor.js"), "utf8"), "vendor.js");
    expect(r.modules.map((m) => m.id)).toEqual(["300", "301", "302"]);
    expect(r.modules[2]!.source.startsWith("302(e,t,n){")).toBe(true);
    expect(r.modules[0]!.source.startsWith("(e,t,n)=>")).toBe(true);
  });

  it("extracts the inline table of a webpack 5 runtime chunk", () => {
    const r = extractModulesFromSource(readFileSync(bundleFixture("wp5", "js", "main.js"), "utf8"), "main.js");
    expect(r.modules.map((m) => m.id)).toEqual(["100", "101"]);
  });

  it("extracts webpack 4 array tables and object chunks", () => {
    const main = extractModulesFromSource(readFileSync(bundleFixture("wp4", "js", "main.js"), "utf8"), "main.js");
    expect(main.modules.map((m) => m.id)).toEqual(["0", "1"]);
    const chunk = extractModulesFromSource(readFileSync(bundleFixture("wp4", "js", "chunk-1.js"), "utf8"), "chunk-1.js");
    expect(chunk.modules.map((m) => m.id)).toEqual(["5", "6"]);
  });

  it("does not mistake ordinary objects of functions with identifier keys for modules", () => {
    expect(extractModulesFromSource("var api={get:function(){},set:function(a){}};", "x.js").modules).toEqual([]);
  });

  it("falls back to a whole-file pseudo-module when the file does not parse", () => {
    const r = extractModulesFromSource("this is not javascript (", "broken.js");
    expect(r.modules).toEqual([{ id: "file:broken.js", file: "broken.js", source: "this is not javascript (", wholeFile: true }]);
    expect(r.warnings[0]).toMatch(/broken\.js: could not parse/);
  });
});

describe("scanBundleDir", () => {
  it("lists files, modules and chunk globals", () => {
    const s = scanBundleDir(bundleFixture("wp5"));
    expect(s.files).toEqual(["js/lazy.js", "js/main.js", "js/vendor.js"]);
    expect(s.modules).toHaveLength(6);
    expect(s.chunkGlobals).toEqual(["webpackChunkfake_plex"]);
    expect(scanBundleDir(bundleFixture("wp4")).chunkGlobals).toEqual(["webpackJsonp"]);
  });

  it("warns when there is nothing to scan", () => {
    const empty = mkdtempSync(join(tmpdir(), "pf-empty-"));
    expect(scanBundleDir(empty).warnings[0]).toMatch(/no \.js files/);
  });
});

describe("runPreflight", () => {
  const defs = [
    plugin([
      { id: "t/menu", find: '"Add to Up Next"', replacements: [{ match: '"Add to Up Next"', replace: '"Add to Up Next","x"' }] },
      { id: "t/capture", find: ["playQueueSelectedItemID", "playQueueID"], onExports: () => {} },
      { id: "t/missing", find: "Not In Bundle", onExports: () => {} },
      { id: "t/bad-rep", find: '"Play Next"', replacements: [{ match: "nope(", replace: "x" }] },
      { id: "t/syntax", find: "method shorthand factory", replacements: [{ match: "method shorthand factory", replace: 'x" + (' }] },
      { id: "t/lazy", lazy: true, find: "Lazy Settings", onExports: () => {} },
      { id: "t/lazy-missing", lazy: true, find: "Lazy Thing That Is Absent", onExports: () => {} },
    ]),
  ];

  it("reports each anchor's resolution precisely and never touches the bundle", () => {
    const dir = bundleFixture("wp5");
    const before = dirHash(dir);
    const r = runPreflight(dir, defs);
    expect(dirHash(dir)).toBe(before);
    const status = Object.fromEntries(r.report.entries.map((e) => [e.patchId, e.status]));
    expect(status).toEqual({
      "t/menu": "applied",
      "t/capture": "applied",
      "t/missing": "failed",
      "t/bad-rep": "failed",
      "t/syntax": "failed",
      "t/lazy": "applied",
      "t/lazy-missing": "failed",
    });
    const codes = r.report.failures.map((f) => `${f.patchId}:${f.code}`);
    expect(codes).toEqual(["t/missing:FIND_UNRESOLVED", "t/bad-rep:REPLACEMENT_NO_MATCH", "t/syntax:COMPILE_ERROR", "t/lazy-missing:FIND_UNRESOLVED"]);
    const text = formatPreflight(r);
    expect(text).toMatch(/chunk globals: {5}webpackChunkfake_plex/);
    expect(text).toMatch(/300: js\/vendor\.js/);
    expect(text).toMatch(/RESULT: 4 required anchor failure\(s\)/);
  });

  it("resolves anchors in genuine minified webpack output", async () => {
    const app = await buildRealWebpackApp();
    const r = runPreflight(app.outDir, [
      plugin([
        { id: "t/menu", find: '"Add to Up Next"', replacements: [{ match: '"Add to Up Next"', replace: '"Add to Up Next","x"' }] },
        { id: "t/queue", find: ["playQueueSelectedItemID", "/playQueues"], onExports: () => {} },
        { id: "t/lazy", lazy: true, find: '"Lazy Settings"', replacements: [{ match: '"Lazy Settings"', replace: '"Lazy!"' }] },
      ]),
    ]);
    expect(r.ok).toBe(true);
    expect(r.modules).toBeGreaterThanOrEqual(3); // production scope hoisting concatenates index+menu
    expect(r.chunkGlobals).toEqual(["webpackChunkfake_plex"]);
  }, 120_000);
});

describe("preflight CLI", () => {
  let cli: string;
  beforeAll(async () => {
    const out = mkdtempSync(join(tmpdir(), "pf-cli-"));
    cli = join(out, "preflight.cjs");
    await build({ entryPoints: [join(root, "preflight/cli.ts")], bundle: true, platform: "node", format: "cjs", outfile: cli, logLevel: "silent" });
  });
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });

  it("exits 1 with a specific report when required anchors fail", () => {
    const r = run("--bundle-dir", bundleFixture("wp5"));
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/FAIL play-from-here\/native-player/);
    expect(r.stdout).toMatch(/FIND_UNRESOLVED: find anchor\(s\) "\/playQueues" occurred in no module/);
  });

  it("exits 0 when everything resolves (only the bundle-independent part is checked here)", () => {
    const dir = mkdtempSync(join(tmpdir(), "pf-ok-"));
    mkdirSync(join(dir, "js"));
    writeFileSync(
      join(dir, "js", "a.js"),
      '(self.webpackChunkx=self.webpackChunkx||[]).push([[1],{1:(e,t,n)=>{e.exports=["Play Next","Add to Up Next"]},2:(e,t,n)=>{e.exports={a:"playQueueSelectedItemID",b:"/playQueues"}}}]);',
    );
    const r = run("--bundle-dir", dir, "--json");
    const json = JSON.parse(r.stdout);
    // anchors resolve, but the native-player integration is still marked todo
    expect(json.report.failures.map((f: any) => f.code)).toEqual(["PATCH_INCOMPLETE"]);
    expect(json.chunkGlobals).toEqual(["webpackChunkx"]);
    expect(r.status).toBe(1);
  });

  it("lists Plex-coupled anchors with their status", () => {
    const r = run("--anchors");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/unverified +bundle\.nativePlayerModule/);
    expect(r.stdout).toMatch(/documented +api\.playQueues/);
  });

  it("rejects bad usage with exit code 2", () => {
    expect(run().status).toBe(2);
    expect(run("--bundle-dir", "/definitely/not/here").status).toBe(2);
    expect(run("--frobnicate").status).toBe(2);
  });
});
