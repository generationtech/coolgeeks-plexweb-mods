/**
 * Helpers to turn a webpack module factory into source text and back.
 */

export const PATCHED = Symbol.for("plexweb-mods.patched");
export const ORIGINAL = Symbol.for("plexweb-mods.original");

const fnToString = Function.prototype.toString;

export function safeSource(fn: unknown): string | null {
  if (typeof fn !== "function") return null;
  try {
    return fnToString.call(fn);
  } catch {
    return null;
  }
}

const METHOD_KEY = /^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[\w$]+)\s*(?=\()/;

/**
 * Normalizes the source of a module factory into a function *expression*.
 * Handles `function(...)`, arrows, and method shorthand (`123(e,t,n){...}`,
 * which webpack emits for some targets). Returns null for native functions.
 */
export function factoryToExpression(src: string): string | null {
  const s = src.trim();
  if (s.includes("[native code]") && /^function\s*[\w$]*\s*\(\s*\)\s*\{\s*\[native code\]\s*\}$/.test(s)) return null;
  if (/^(?:async\s+)?function\b/.test(s)) return s;
  if (s.startsWith("(") || /^async\s*\(/.test(s)) return s; // (args) => ...
  if (/^(?:async\s+)?[\w$]+\s*=>/.test(s)) return s; // e => ...
  const asyncPrefix = /^async\s+/.exec(s)?.[0] ?? "";
  const rest = s.slice(asyncPrefix.length);
  const key = METHOD_KEY.exec(rest);
  if (key) return `${asyncPrefix}function${rest.slice(key[0].length)}`;
  return null;
}

/** Compiles a factory expression in the given realm via indirect eval. */
export function compileFactory(code: string, moduleId: string, evalFn: (src: string) => unknown): (...args: any[]) => any {
  const url = `plexweb-mods://patched-module/${encodeURIComponent(moduleId)}`;
  const fn = evalFn(`0,${code}\n//# sourceURL=${url}`);
  if (typeof fn !== "function") throw new TypeError(`patched module ${moduleId} did not evaluate to a function`);
  return fn as (...args: any[]) => any;
}
