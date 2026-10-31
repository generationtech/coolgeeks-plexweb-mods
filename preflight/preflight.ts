/**
 * Preflight: resolves every patch anchor against a Plex Web bundle directory
 * WITHOUT modifying anything, and reports exactly which anchors resolved.
 */
import { parse } from "acorn";
import { formatReport, PatchSession, type PatchReport } from "../runtime/engine";
import { factoryToExpression } from "../runtime/factory";
import type { PluginDef } from "../runtime/types";
import { scanBundleDir, type BundleScan } from "./extract";

export interface PreflightResult {
  dir: string;
  ok: boolean;
  files: number;
  modules: number;
  chunkGlobals: string[];
  warnings: string[];
  /** module id -> files containing it (for locating anchors). */
  moduleFiles: Record<string, string[]>;
  report: PatchReport;
}

const syntaxCheck = (code: string): Error | null => {
  try {
    parse(`(0,${code})`, { ecmaVersion: "latest" });
    return null;
  } catch (err) {
    return err as Error;
  }
};

export function runPreflight(dir: string, plugins: readonly PluginDef[]): PreflightResult {
  const scan = scanBundleDir(dir);
  const session = new PatchSession(plugins);
  const moduleFiles: Record<string, string[]> = {};
  for (const m of scan.modules) {
    const files = (moduleFiles[m.id] ??= []);
    if (!files.includes(m.file)) files.push(m.file);
    const expr = m.wholeFile ? m.source : (factoryToExpression(m.source) ?? m.source);
    session.transform(m.id, expr, m.wholeFile ? undefined : syntaxCheck);
  }
  // Preflight sees the whole bundle, so lazy anchors must resolve too.
  const report = session.report({ final: true, lazyIsFinal: true });
  return {
    dir,
    ok: report.ok,
    files: scan.files.length,
    modules: scan.modules.length,
    chunkGlobals: scan.chunkGlobals,
    warnings: scan.warnings,
    moduleFiles,
    report,
  };
}

export function formatPreflight(r: PreflightResult): string {
  const lines = [
    `preflight: ${r.dir}`,
    `  files scanned:     ${r.files}`,
    `  modules extracted: ${r.modules}`,
    `  chunk globals:     ${r.chunkGlobals.join(", ") || "(none found)"}`,
    ...r.warnings.map((w) => `  warning: ${w}`),
    "",
    formatReport(r.report),
    "",
  ];
  const located = r.report.entries.flatMap((e) => e.located);
  if (located.length) {
    lines.push("module locations:");
    for (const id of [...new Set(located)]) lines.push(`  ${id}: ${(r.moduleFiles[id] ?? []).join(", ")}`);
    lines.push("");
  }
  lines.push(
    r.ok
      ? "RESULT: all required anchors resolved (export-capture shapes are only checked at runtime)."
      : `RESULT: ${r.report.failures.length} required anchor failure(s). Do not apply until fixed (or pass --force to the injector).`,
  );
  return lines.join("\n");
}

export interface FindResult {
  needle: string;
  /** Modules whose source contains the needle (ids and files only, never code). */
  modules: Array<{ id: string; file: string; count: number }>;
}

/**
 * Research helper: which modules contain each short string? Prints module
 * ids, files and occurrence counts only, so findings can be written up
 * without copying Plex code.
 */
export function findInBundle(dir: string, needles: readonly string[], scan: BundleScan = scanBundleDir(dir)): FindResult[] {
  return needles.map((needle) => ({
    needle,
    modules: scan.modules
      .map((m) => ({ id: m.id, file: m.file, count: m.source.split(needle).length - 1 }))
      .filter((m) => m.count > 0),
  }));
}

export function formatFind(results: readonly FindResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    lines.push(`${JSON.stringify(r.needle)}: ${r.modules.length} module(s)`);
    for (const m of r.modules) lines.push(`  ${m.id} (${m.file}) x${m.count}`);
  }
  if (results.length > 1) {
    const sets = results.map((r) => new Set(r.modules.map((m) => m.id)));
    const all = [...sets[0]!].filter((id) => sets.every((s) => s.has(id)));
    lines.push(`modules containing ALL of them: ${all.join(", ") || "(none)"}`);
  }
  return lines.join("\n");
}
