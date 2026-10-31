// The loader against genuine webpack 5 production output (runtime chunk,
// split chunk, lazy chunk loaded through webpack's own script loader).
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PatchSession } from "../runtime/engine";
import { installWebpackHooks, type WebpackHooks } from "../runtime/loader";
import type { PluginDef } from "../runtime/types";
import { createRealm, type Realm } from "./helpers/realm";
import { buildRealWebpackApp, type BuiltApp } from "./helpers/webpack-build";

let app: BuiltApp;
beforeAll(async () => {
  app = await buildRealWebpackApp();
}, 120_000);

const cleanup: WebpackHooks[] = [];
afterEach(() => cleanup.splice(0).forEach((h) => h.uninstall()));

/** Minimal DOM so webpack's runtime can load lazy chunks via <script>. */
function fakeDocument(getRealm: () => Realm, outDir: string) {
  return {
    getElementsByTagName: () => [],
    createElement: () => ({ setAttribute() {}, getAttribute() {}, parentNode: { removeChild() {} } }),
    head: {
      appendChild(script: any) {
        setTimeout(() => {
          const file = String(script.src).replace(/^js\//, "");
          getRealm().run(readFileSync(join(outDir, file), "utf8"), file);
          script.onload?.({ type: "load", target: script });
        }, 0);
      },
    },
  };
}

function boot(order: string[], chunkGlobals: string[]) {
  const captured: unknown[] = [];
  const plugin: PluginDef & { captured: unknown[] } = {
    name: "demo",
    description: "",
    captured,
    patches: [
      { id: "demo/menu", find: '"Add to Up Next"', replacements: [{ match: '"Add to Up Next"', replace: '"Add to Up Next","Play from here"' }] },
      { id: "demo/queue", find: ["playQueueSelectedItemID", "/playQueues"], onExports: (e) => void captured.push(e) },
      { id: "demo/lazy", lazy: true, find: '"Lazy Settings"', replacements: [{ match: '"Lazy Settings"', replace: '"Lazy Settings (patched)"' }] },
    ],
  };
  const realm: Realm = createRealm({ setTimeout, clearTimeout, document: fakeDocument(() => realm, app.outDir) });
  const session = new PatchSession([plugin]);
  cleanup.push(installWebpackHooks({ session, target: realm.global, chunkGlobals }));
  realm.global.__plexwebMods = { plugins: { demo: plugin } };
  for (const f of order) realm.run(readFileSync(join(app.outDir, f), "utf8"), f);
  return { realm, session, plugin };
}

describe("real webpack 5 build", () => {
  it("emits the expected files", () => {
    expect(app.files).toEqual(expect.arrayContaining(["runtime.js", "shared.js", "main.js", "lazy.chunk.js"]));
  });

  for (const [label, order] of [
    ["runtime first", ["runtime.js", "shared.js", "main.js"]],
    ["chunks before runtime", ["shared.js", "main.js", "runtime.js"]],
  ] as const) {
    for (const globals of [["webpackChunkfake_plex"], []]) {
      it(`patches initial + lazy chunks (${label}, chunk global ${globals.length ? "hooked" : "not hooked"})`, async () => {
        const { realm, session, plugin } = boot([...order], globals);
        expect(realm.global.__result).toBe("Play Next|Add to Up Next|Play from here");
        expect(plugin.captured).toHaveLength(1);
        expect(realm.global.__queue.playQueueSelectedItemID).toBe(2);
        await expect(realm.run("__lazy()")).resolves.toBe("Lazy Settings (patched)");
        const report = session.report({ final: true, lazyIsFinal: true });
        expect(report.failures).toEqual([]);
        expect(report.entries.every((e) => e.status === "applied")).toBe(true);
      });
    }
  }
});
