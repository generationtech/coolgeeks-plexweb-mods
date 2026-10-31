import { afterEach, describe, expect, it } from "vitest";
import { PatchSession } from "../runtime/engine";
import { factoryToExpression } from "../runtime/factory";
import { installWebpackHooks, type WebpackHooks } from "../runtime/loader";
import type { PluginDef } from "../runtime/types";
import { bundleFixture, createRealm, type Realm } from "./helpers/realm";

const hooks: WebpackHooks[] = [];
afterEach(() => {
  while (hooks.length) hooks.pop()!.uninstall();
});

function setup(plugins: PluginDef[], chunkGlobals: string[] = []) {
  const realm = createRealm();
  const session = new PatchSession(plugins);
  const h = installWebpackHooks({ session, target: realm.global, chunkGlobals });
  hooks.push(h);
  // $self resolves through globalThis.__plexwebMods.plugins[name] in the realm.
  realm.global.__plexwebMods = { plugins: Object.fromEntries(plugins.map((p) => [p.name, p])) };
  return { realm, session, h };
}

const loadWp5 = (realm: Realm, ...files: string[]) => files.forEach((f) => realm.runFile(bundleFixture("wp5", "js", f)));
const loadWp4 = (realm: Realm, ...files: string[]) => files.forEach((f) => realm.runFile(bundleFixture("wp4", "js", f)));

/** A plugin that rewrites the menu labels and captures the "player" exports. */
function demoPlugin() {
  const captured: unknown[] = [];
  const p = {
    name: "demo",
    description: "test plugin",
    captured,
    called: [] as string[],
    note(x: string) {
      p.called.push(x);
      return x;
    },
    patches: [
      {
        id: "demo/menu",
        find: '"Add to Up Next"',
        replacements: [{ match: '"Add to Up Next"', replace: '"Add to Up Next",$self.note("Play from here")' }],
      },
      { id: "demo/player", find: ['"native-player:"', "start"], onExports: (e: unknown) => void captured.push(e) },
    ],
  };
  return p;
}

describe("factoryToExpression", () => {
  it.each([
    ["function(e,t,n){return 1}", "function(e,t,n){return 1}"],
    ["(e,t,n)=>{}", "(e,t,n)=>{}"],
    ["e=>e", "e=>e"],
    ["302(e,t,n){return 2}", "function(e,t,n){return 2}"],
    ['"./src/a.js"(e){}', "function(e){}"],
    ["async 5(e){}", "async function(e){}"],
    ["function () { [native code] }", null],
  ])("%s", (src, expected) => {
    expect(factoryToExpression(src)).toBe(expected);
  });
});

describe("webpack 5 style bundle", () => {
  it("patches modules pushed before the runtime, inline in the runtime, and in lazy chunks", () => {
    const plugin = demoPlugin();
    const { realm, session, h } = setup([plugin], ["webpackChunkfake_plex"]);
    loadWp5(realm, "vendor.js", "main.js");
    // module 300 (vendor chunk, pushed before the runtime) was patched
    expect(realm.global.__bootResult).toBe("booted:Play Next|Add to Up Next|Play from here");
    expect(plugin.called).toEqual(["Play from here"]);
    // module 101 (inline in the runtime chunk): capture fires once it executes
    realm.run("__fakeRequire(101)");
    expect(plugin.captured).toHaveLength(1);
    expect((plugin.captured[0] as any).player.start("x")).toBe("native-player:x");
    // lazy chunk after the runtime installed its push callback
    loadWp5(realm, "lazy.js");
    expect(realm.run("__fakeRequire(400).settings().label")).toBe("Lazy Settings");
    expect(h.stats.factoriesPatched).toBe(2);
    expect(h.stats.moduleTables).toBe(1);
    const report = session.report({ final: true });
    expect(report.ok).toBe(true);
    expect(report.entries.map((e) => [e.patchId, e.status, e.located])).toEqual([
      ["demo/menu", "applied", ["300"]],
      ["demo/player", "applied", ["101"]],
    ]);
  });

  it("works through the Function.prototype.m trap alone (no chunk global configured)", () => {
    const plugin = demoPlugin();
    const { realm, h } = setup([plugin], []);
    loadWp5(realm, "vendor.js", "main.js", "lazy.js");
    expect(realm.global.__bootResult).toContain("Play from here");
    expect(h.hookedChunkGlobals).toEqual([]);
  });

  it("method-shorthand factories survive the round trip", () => {
    const { realm } = setup(
      [
        {
          name: "sh",
          description: "",
          patches: [{ id: "sh/x", find: "method shorthand factory", replacements: [{ match: "method shorthand", replace: "patched shorthand" }] }],
        },
      ],
      ["webpackChunkfake_plex"],
    );
    loadWp5(realm, "vendor.js", "main.js");
    expect(realm.run("__fakeRequire(302).shorthand()")).toBe("patched shorthand factory");
  });

  it("leaves the module untouched when a replacement anchor misses", () => {
    const { realm, session } = setup([
      {
        name: "miss",
        description: "",
        patches: [{ id: "miss/x", find: '"Add to Up Next"', replacements: [{ match: "nonexistent()", replace: "boom()" }] }],
      },
    ]);
    loadWp5(realm, "vendor.js", "main.js");
    expect(realm.global.__bootResult).toBe("booted:Play Next|Add to Up Next");
    const f = session.report().failures;
    expect(f).toHaveLength(1);
    expect(f[0]!.message).toMatch(/\[miss\/x\] REPLACEMENT_NO_MATCH: module 300 .*"nonexistent\(\)"/);
  });

  it("reverts a patch that produces invalid JavaScript and keeps Plex running", () => {
    const { realm, session } = setup([
      {
        name: "bad",
        description: "",
        patches: [{ id: "bad/x", find: '"Add to Up Next"', replacements: [{ match: '"Add to Up Next"', replace: '"Add to Up Next" ) syntax error' }] }],
      },
    ]);
    loadWp5(realm, "vendor.js", "main.js");
    expect(realm.global.__bootResult).toBe("booted:Play Next|Add to Up Next");
    expect(session.report().failures[0]!.code).toBe("COMPILE_ERROR");
  });

  it("late-hooks a chunk global discovered after Plex loaded", () => {
    // webpack 4 is the case that needs it: strategy A cannot see chunk modules.
    const plugin = demoPlugin();
    const { realm, h } = setup([plugin], []);
    loadWp4(realm, "main.js");
    expect(h.scanForChunkGlobals()).toEqual(["webpackJsonp"]);
    expect(h.scanForChunkGlobals()).toEqual([]); // idempotent
    loadWp4(realm, "chunk-1.js");
    expect(realm.run("__fakeRequire(5).menuItems().join('|')")).toBe("Play Next|Add to Up Next|Play from here");
  });

  it("does not disturb unrelated functions that assign .m", () => {
    const { realm } = setup([demoPlugin()]);
    expect(realm.run("function f(){}; f.m = {a: 1}; f.m.a")).toBe(1);
    expect(realm.run("function g(){}; g.m")).toBeUndefined();
  });
});

describe("webpack 4 style bundle (webpackJsonp)", () => {
  it("patches chunk modules via the chunk-global trap", () => {
    const plugin = demoPlugin();
    const { realm, session } = setup([plugin], ["webpackJsonp"]);
    loadWp4(realm, "main.js", "chunk-1.js");
    expect(realm.run("__fakeRequire(5).menuItems().join('|')")).toBe("Play Next|Add to Up Next|Play from here");
    realm.run("__fakeRequire(1)");
    expect(plugin.captured).toHaveLength(1);
    expect(session.report({ final: true }).ok).toBe(true);
  });

  it("without the chunk global hooked, webpack 4 chunk modules are NOT patched (documents why strategy B exists)", () => {
    const plugin = demoPlugin();
    const { realm, session } = setup([plugin], []);
    loadWp4(realm, "main.js", "chunk-1.js");
    expect(realm.run("__fakeRequire(5).menuItems().join('|')")).toBe("Play Next|Add to Up Next");
    // the session never saw module 5's source through strategy A
    expect(session.report({ final: true }).failures.map((f) => f.patchId)).toEqual(["demo/menu"]);
  });
});

describe("uninstall", () => {
  it("removes the Function.prototype trap and chunk-global accessors", () => {
    const realm = createRealm();
    const h = installWebpackHooks({ session: new PatchSession([]), target: realm.global, chunkGlobals: ["webpackJsonp"] });
    expect(Object.getOwnPropertyDescriptor(realm.global.Function.prototype, "m")).toBeDefined();
    h.uninstall();
    expect(Object.getOwnPropertyDescriptor(realm.global.Function.prototype, "m")).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(realm.global, "webpackJsonp")).toBeUndefined();
  });
});
