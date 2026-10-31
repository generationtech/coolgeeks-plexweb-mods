/**
 * Extracts webpack module factories from bundle files *without executing
 * them*, so the patch engine can be run against a bundle on disk.
 *
 * A "module table" is an object literal whose properties all have literal
 * keys and function values with at most 3 params (webpack 4/5 chunk payloads,
 * `__webpack_modules__`), or an array of such functions passed to a call or
 * nested in a chunk tuple (webpack 4 numeric tables). The text range of each
 * factory mirrors what Function.prototype.toString returns at runtime.
 */
import { parse } from "acorn";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export interface ExtractedModule {
  id: string;
  file: string;
  /** Source as Function.prototype.toString would print it. */
  source: string;
  /** True when the file could not be parsed and is scanned as one pseudo-module. */
  wholeFile?: boolean;
}

export interface BundleScan {
  files: string[];
  modules: ExtractedModule[];
  chunkGlobals: string[];
  warnings: string[];
}

type Node = { type: string; start: number; end: number; [k: string]: any };

const isFn = (n: Node | null | undefined): boolean =>
  !!n && (n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression") && n.params.length <= 3;

function objectTable(node: Node): Array<{ id: string; start: number; end: number }> | null {
  if (node.type !== "ObjectExpression" || node.properties.length === 0) return null;
  const out: Array<{ id: string; start: number; end: number }> = [];
  for (const p of node.properties as Node[]) {
    if (p.type !== "Property" || p.computed || p.kind !== "init") return null;
    if (p.key.type !== "Literal" || (typeof p.key.value !== "number" && typeof p.key.value !== "string")) return null;
    if (!isFn(p.value)) return null;
    // method shorthand: toString() includes the key ("302(e,t,n){...}")
    out.push({ id: String(p.key.value), start: p.method ? p.start : p.value.start, end: p.value.end });
  }
  return out;
}

function arrayTable(node: Node, parent: Node | null): Array<{ id: string; start: number; end: number }> | null {
  if (node.type !== "ArrayExpression" || !parent) return null;
  if (parent.type !== "CallExpression" && parent.type !== "ArrayExpression") return null;
  const out: Array<{ id: string; start: number; end: number }> = [];
  let fns = 0;
  for (let i = 0; i < node.elements.length; i++) {
    const el = node.elements[i] as Node | null;
    if (el === null) continue;
    if (!isFn(el)) return null;
    fns++;
    out.push({ id: String(i), start: el.start, end: el.end });
  }
  return fns > 0 ? out : null;
}

export function extractModulesFromSource(code: string, file: string): { modules: ExtractedModule[]; warnings: string[] } {
  let ast: Node;
  try {
    ast = parse(code, { ecmaVersion: "latest", sourceType: "script", allowHashBang: true, allowReturnOutsideFunction: true }) as unknown as Node;
  } catch (err) {
    try {
      ast = parse(code, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true }) as unknown as Node;
    } catch {
      return {
        modules: [{ id: `file:${file}`, file, source: code, wholeFile: true }],
        warnings: [`${file}: could not parse (${(err as Error).message}); scanned as a single pseudo-module`],
      };
    }
  }
  const modules: ExtractedModule[] = [];
  const stack: Array<{ node: Node; parent: Node | null }> = [{ node: ast, parent: null }];
  while (stack.length) {
    const { node, parent } = stack.pop()!;
    const table = objectTable(node) ?? arrayTable(node, parent);
    if (table) {
      for (const t of table) modules.push({ id: t.id, file, source: code.slice(t.start, t.end) });
      continue; // never look for tables inside modules
    }
    for (const key of Object.keys(node)) {
      if (key === "type" || key === "start" || key === "end") continue;
      const v = node[key];
      if (Array.isArray(v)) {
        for (let i = v.length - 1; i >= 0; i--) if (v[i] && typeof v[i].type === "string") stack.push({ node: v[i], parent: node });
      } else if (v && typeof v.type === "string") {
        stack.push({ node: v, parent: node });
      }
    }
  }
  modules.sort((a, b) => code.indexOf(a.source) - code.indexOf(b.source));
  return { modules, warnings: [] };
}

/** webpack chunk-loading global names referenced in the code. */
export function detectChunkGlobals(code: string): string[] {
  const names = new Set<string>();
  for (const m of code.matchAll(/\b(webpackChunk[\w$]*|webpackJsonp[\w$]*)\b/g)) names.add(m[1]!);
  return [...names];
}

export function listJsFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (/\.(c|m)?js$/.test(name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** Reads every .js file under `dir` (read-only) and extracts modules. */
export function scanBundleDir(dir: string): BundleScan {
  const files = listJsFiles(dir);
  const modules: ExtractedModule[] = [];
  const warnings: string[] = [];
  const globals = new Set<string>();
  for (const path of files) {
    const rel = relative(dir, path);
    const code = readFileSync(path, "utf8");
    detectChunkGlobals(code).forEach((g) => globals.add(g));
    const r = extractModulesFromSource(code, rel);
    modules.push(...r.modules);
    warnings.push(...r.warnings);
  }
  if (files.length === 0) warnings.push(`no .js files found under ${dir}`);
  else if (modules.length === 0) warnings.push("no webpack module tables found; is this a webpack bundle?");
  return { files: files.map((f) => relative(dir, f)), modules, chunkGlobals: [...globals], warnings };
}
