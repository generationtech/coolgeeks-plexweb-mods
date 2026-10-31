// A fresh JS realm (node:vm context) that looks enough like a browser window
// for webpack-style bundles: self/window alias the global object.
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface Realm {
  global: any;
  run(code: string, filename?: string): unknown;
  runFile(path: string): unknown;
}

export function createRealm(extraGlobals: Record<string, unknown> = {}): Realm {
  const ctx = vm.createContext({ console, ...extraGlobals });
  vm.runInContext("globalThis.self = globalThis; globalThis.window = globalThis;", ctx);
  const global = vm.runInContext("globalThis", ctx);
  return {
    global,
    run: (code, filename = "inline.js") => vm.runInContext(code, ctx, { filename }),
    runFile: (path) => vm.runInContext(readFileSync(path, "utf8"), ctx, { filename: path }),
  };
}

export const fixturesDir = join(import.meta.dirname, "..", "fixtures");
export const bundleFixture = (...p: string[]) => join(fixturesDir, "bundles", ...p);
