/**
 * Webpack hooks. Patches module factories *before* webpack can execute them,
 * using two complementary strategies:
 *
 *  A. `Function.prototype.m` trap: the webpack runtime publishes its module
 *     table as `__webpack_require__.m = modules`. A setter on
 *     Function.prototype sees that assignment, patches every factory already
 *     in the table, and swaps `.m` for a Proxy so factories that chunks add
 *     later (webpack 5 writes through `__webpack_require__.m[id] = f`) are
 *     patched on insertion. Needs no knowledge of the chunk global's name.
 *
 *  B. Chunk-global trap: for each configured name (e.g. `webpackChunkfoo`,
 *     `webpackJsonp`), intercept the array and its `push`, and patch the
 *     factories inside every chunk before webpack's own callback copies them.
 *     Required for webpack 4, whose callback writes to a private variable.
 *
 * Both paths funnel into patchFactory(), which is idempotent.
 */
import type { PatchSession } from "./engine";
import { compileFactory, factoryToExpression, ORIGINAL, PATCHED, safeSource } from "./factory";
import type { Logger } from "./types";

export interface WebpackHookOptions {
  session: PatchSession;
  /** The realm's global object (window in the browser). */
  target: any;
  chunkGlobals?: readonly string[];
  log?: Logger;
}

export interface WebpackHookStats {
  moduleTables: number;
  chunks: number;
  factoriesSeen: number;
  factoriesPatched: number;
  factoriesUnreadable: number;
}

export interface WebpackHooks {
  readonly stats: WebpackHookStats;
  readonly hookedChunkGlobals: readonly string[];
  /** Hook a chunk global by name (safe to call late; patches future chunks). */
  hookChunkGlobal(name: string): void;
  /** Find webpack chunk globals on the target that were not hooked; hooks them late. */
  scanForChunkGlobals(): string[];
  /** Exposed for diagnostics/tests. */
  patchFactory(id: string, factory: unknown): unknown;
  uninstall(): void;
}

const CHUNK_GLOBAL_PATTERN = /^webpack(?:Chunk|Jsonp)/;
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export function looksLikeWebpackRequire(fn: unknown, modules: unknown): boolean {
  if (typeof fn !== "function" || !modules || typeof modules !== "object") return false;
  const src = safeSource(fn);
  return !!src && /exports\s*:\s*\{\s*\}/.test(src);
}

export function installWebpackHooks(opts: WebpackHookOptions): WebpackHooks {
  const { session, target } = opts;
  const log = opts.log ?? silent;
  const evalFn: (s: string) => unknown = target.eval;
  const stats: WebpackHookStats = { moduleTables: 0, chunks: 0, factoriesSeen: 0, factoriesPatched: 0, factoriesUnreadable: 0 };
  const processed = new WeakSet<object>();
  const hookedArrays = new WeakSet<object>();
  const hookedNames: string[] = [];
  const restore: Array<() => void> = [];

  function patchFactory(id: string, factory: unknown): unknown {
    if (typeof factory !== "function") return factory;
    if ((factory as any)[PATCHED] || processed.has(factory)) return factory;
    processed.add(factory);
    stats.factoriesSeen++;

    const src = safeSource(factory);
    const expr = src === null ? null : factoryToExpression(src);
    if (expr === null) {
      stats.factoriesUnreadable++;
      return factory;
    }

    let compiled: { code: string; fn: (...a: any[]) => any } | null = null;
    const result = session.transform(String(id), expr, (code) => {
      try {
        compiled = { code, fn: compileFactory(code, String(id), evalFn) };
        return null;
      } catch (err) {
        return err instanceof Error ? err : new Error(String(err));
      }
    });
    if (!result.changed && result.captures.length === 0) return factory;

    let out: (...a: any[]) => any = factory as (...a: any[]) => any;
    if (result.changed) {
      const c = compiled as { code: string; fn: (...a: any[]) => any } | null;
      out = c && c.code === result.code ? c.fn : compileFactory(result.code, String(id), evalFn);
    }
    if (result.captures.length) {
      const inner = out;
      const captures = result.captures;
      out = function (this: unknown, module: any, ...rest: any[]) {
        const ret = inner.call(this, module, ...rest);
        for (const c of captures) c.run(module?.exports, String(id));
        return ret;
      };
    }
    Object.defineProperty(out, PATCHED, { value: true });
    Object.defineProperty(out, ORIGINAL, { value: factory });
    processed.add(out);
    stats.factoriesPatched++;
    log.debug(`patched module ${id}: ${result.applied.join(", ")}`);
    return out;
  }

  function patchTableInPlace(table: any): void {
    for (const key of Object.keys(table)) {
      const f = table[key];
      const p = patchFactory(key, f);
      if (p !== f) table[key] = p;
    }
  }

  function patchChunk(chunk: unknown): void {
    if (!Array.isArray(chunk) || processed.has(chunk)) return;
    processed.add(chunk);
    const modules = chunk[1];
    if (!modules || typeof modules !== "object") return;
    stats.chunks++;
    patchTableInPlace(modules);
  }

  // --- Strategy A: Function.prototype.m -------------------------------------
  const FnProto = target.Function.prototype;
  const prior = Object.getOwnPropertyDescriptor(FnProto, "m");
  if (prior) {
    log.warn("Function.prototype.m is already defined; webpack require hook (strategy A) disabled.");
  } else {
    Object.defineProperty(FnProto, "m", {
      configurable: true,
      enumerable: false,
      set(this: any, modules: any) {
        Object.defineProperty(this, "m", { value: modules, writable: true, configurable: true, enumerable: true });
        if (!looksLikeWebpackRequire(this, modules)) return;
        try {
          stats.moduleTables++;
          patchTableInPlace(modules);
          const proxy = new Proxy(modules, {
            set(t, key, value) {
              t[key as any] = typeof key === "string" ? patchFactory(key, value) : value;
              return true;
            },
            defineProperty(t, key, desc) {
              if (typeof key === "string" && "value" in desc) desc = { ...desc, value: patchFactory(key, desc.value) };
              return Reflect.defineProperty(t, key, desc);
            },
          });
          Object.defineProperty(this, "m", { value: proxy, writable: true, configurable: true, enumerable: true });
        } catch (err) {
          log.error("failed to hook webpack module table", err);
        }
      },
    });
    restore.push(() => {
      delete FnProto.m;
    });
  }

  // --- Strategy B: chunk globals --------------------------------------------
  function hookArray(arr: any[]): void {
    if (hookedArrays.has(arr)) return;
    hookedArrays.add(arr);
    for (const c of arr) patchChunk(c);
    const own = Object.getOwnPropertyDescriptor(arr, "push");
    let installed: ((...a: any[]) => any) | null = own && typeof own.value === "function" ? own.value : null;
    const basePush = function (this: any, ...chunks: any[]) {
      chunks.forEach(patchChunk);
      return Array.prototype.push.apply(this, chunks);
    };
    const outerPush = function (this: any, ...chunks: any[]) {
      chunks.forEach(patchChunk);
      return installed!.apply(this, chunks);
    };
    Object.defineProperty(arr, "push", {
      configurable: true,
      enumerable: false,
      get: () => (installed ? outerPush : basePush),
      // webpack's runtime binds the current push as its "parent" and then
      // assigns its own callback; keep that callback behind outerPush.
      set: (fn) => {
        installed = fn;
      },
    });
  }

  function hookChunkGlobal(name: string): void {
    if (hookedNames.includes(name)) return;
    const desc = Object.getOwnPropertyDescriptor(target, name);
    if (desc && !desc.configurable) {
      log.warn(`chunk global ${name} is not configurable; cannot hook it.`);
      return;
    }
    let value = target[name];
    if (Array.isArray(value)) hookArray(value);
    Object.defineProperty(target, name, {
      configurable: true,
      enumerable: true,
      get: () => value,
      set: (v) => {
        value = v;
        if (Array.isArray(v)) hookArray(v);
      },
    });
    hookedNames.push(name);
    restore.push(() => {
      delete target[name];
      if (value !== undefined) target[name] = value;
    });
  }

  for (const name of opts.chunkGlobals ?? []) hookChunkGlobal(name);

  return {
    stats,
    hookedChunkGlobals: hookedNames,
    hookChunkGlobal,
    scanForChunkGlobals() {
      const late = Object.getOwnPropertyNames(target).filter((n) => CHUNK_GLOBAL_PATTERN.test(n) && !hookedNames.includes(n));
      for (const n of late) {
        log.warn(
          `chunk global "${n}" existed before it was hooked; hooking it now (only chunks loaded from here on are patched ` +
            `via this path). Pass it to the loader via data-chunk-globals to hook it early.`,
        );
        hookChunkGlobal(n);
      }
      return late;
    },
    patchFactory,
    uninstall() {
      while (restore.length) restore.pop()!();
    },
  };
}
