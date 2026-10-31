/**
 * String-anchored patch engine. Environment-agnostic: no DOM, no eval.
 * The browser loader and the Node preflight both drive a PatchSession by
 * feeding it module sources; the session decides which patches apply,
 * rewrites the source, and tracks the resolution state of every anchor so it
 * can report precisely which anchor failed and why.
 */
import type { Matcher, PatchDef, PluginDef, ReplaceFn } from "./types";

export type IssueCode =
  /** No module contained all `find` anchors (only raised by a final report). */
  | "FIND_UNRESOLVED"
  /** `find` anchors matched more than one module and `all` is not set. */
  | "FIND_AMBIGUOUS"
  /** A module matched `find`, but a replacement anchor did not occur in it. */
  | "REPLACEMENT_NO_MATCH"
  /** The patched source did not compile / parse; the patch was reverted. */
  | "COMPILE_ERROR"
  /** onExports threw. */
  | "EXPORTS_HANDLER_ERROR"
  /** onExports returned false: exports did not have the expected shape. */
  | "EXPORTS_UNRECOGNIZED";

export interface PatchIssue {
  code: IssueCode;
  plugin: string;
  patchId: string;
  optional: boolean;
  moduleId?: string;
  /** Printable form of the anchor involved, when there is one. */
  anchor?: string;
  message: string;
}

export interface AnchorState {
  kind: "find" | "replacement";
  index: number;
  anchor: string;
  /** Number of modules this anchor occurred in (find) / was applied in (replacement). */
  hits: number;
  /** First few module ids, for the report. */
  modules: string[];
}

export type PatchStatus = "applied" | "pending" | "failed";

export interface PatchReportEntry {
  plugin: string;
  patchId: string;
  optional: boolean;
  lazy: boolean;
  note?: string;
  status: PatchStatus;
  /** Modules whose source contained every `find` anchor. */
  located: string[];
  /** Modules the patch was applied to. */
  applied: string[];
  anchors: AnchorState[];
  issues: PatchIssue[];
}

export interface PatchReport {
  /** True when no required patch failed. */
  ok: boolean;
  final: boolean;
  modulesSeen: number;
  entries: PatchReportEntry[];
  failures: PatchIssue[];
  warnings: PatchIssue[];
}

export interface CapturePoint {
  patchId: string;
  run(exports: unknown, moduleId: string): void;
}

export interface TransformResult {
  code: string;
  changed: boolean;
  /** Ids of patches applied to this module. */
  applied: string[];
  /** Export captures to run after this module's factory executes. */
  captures: CapturePoint[];
  issues: PatchIssue[];
}

export interface SessionOptions {
  /** Expression that evaluates to the plugin object at runtime ($self). */
  selfExpr?: (plugin: string) => string;
  /** Called for every issue as soon as it is detected. */
  onIssue?: (issue: PatchIssue) => void;
  /** Max module ids remembered per anchor (report size cap). */
  maxModulesPerAnchor?: number;
}

/** Returns an Error when `code` is not acceptable, or null. */
export type Validator = (code: string) => Error | null;

interface PatchRuntimeState {
  plugin: string;
  def: PatchDef;
  finds: readonly Matcher[];
  anchors: AnchorState[];
  located: string[];
  applied: string[];
  issues: PatchIssue[];
}

export function printableMatcher(m: Matcher): string {
  if (typeof m === "string") {
    const s = JSON.stringify(m);
    return s.length > 90 ? `${s.slice(0, 87)}..."` : s;
  }
  return String(m);
}

/** Non-global, non-sticky clone, safe for repeated .test() calls. */
function testerFor(m: Matcher): (s: string) => boolean {
  if (typeof m === "string") return (s) => s.includes(m);
  const re = new RegExp(m.source, m.flags.replace(/[gy]/g, ""));
  return (s) => re.test(s);
}

function freshRegExp(m: RegExp): RegExp {
  return new RegExp(m.source, m.flags);
}

export const defaultSelfExpr = (plugin: string): string =>
  `globalThis.__plexwebMods.plugins[${JSON.stringify(plugin)}]`;

export class PatchSession {
  readonly plugins: readonly PluginDef[];
  private readonly states: PatchRuntimeState[] = [];
  private readonly seenModules = new Set<string>();
  private readonly selfExpr: (plugin: string) => string;
  private readonly onIssue?: (issue: PatchIssue) => void;
  private readonly maxModules: number;

  constructor(plugins: readonly PluginDef[], options: SessionOptions = {}) {
    this.plugins = plugins;
    this.selfExpr = options.selfExpr ?? defaultSelfExpr;
    this.onIssue = options.onIssue;
    this.maxModules = options.maxModulesPerAnchor ?? 8;

    const ids = new Set<string>();
    for (const plugin of plugins) {
      for (const def of plugin.patches) {
        if (ids.has(def.id)) throw new Error(`duplicate patch id "${def.id}"`);
        ids.add(def.id);
        const finds: readonly Matcher[] = Array.isArray(def.find) ? def.find : [def.find as Matcher];
        if (finds.length === 0) throw new Error(`patch "${def.id}" has no find anchors`);
        if (!def.replacements?.length && !def.onExports) {
          throw new Error(`patch "${def.id}" has neither replacements nor onExports`);
        }
        const anchors: AnchorState[] = [
          ...finds.map((m, index) => ({ kind: "find" as const, index, anchor: printableMatcher(m), hits: 0, modules: [] })),
          ...(def.replacements ?? []).map((r, index) => ({
            kind: "replacement" as const,
            index,
            anchor: printableMatcher(r.match),
            hits: 0,
            modules: [],
          })),
        ];
        this.states.push({ plugin: plugin.name, def, finds, anchors, located: [], applied: [], issues: [] });
      }
    }
  }

  get modulesSeen(): number {
    return this.seenModules.size;
  }

  /**
   * Run every patch against one module's source. `validate` (optional) is
   * called after each patch that changed the code; a non-null return reverts
   * that patch and records COMPILE_ERROR.
   */
  transform(moduleId: string, source: string, validate?: Validator): TransformResult {
    this.seenModules.add(moduleId);
    let code = source;
    const applied: string[] = [];
    const captures: CapturePoint[] = [];
    const issues: PatchIssue[] = [];

    for (const st of this.states) {
      // 1. Locate: every find anchor must occur in the ORIGINAL module source.
      let all = true;
      st.finds.forEach((m, i) => {
        if (testerFor(m)(source)) this.hit(st.anchors[i]!, moduleId);
        else all = false;
      });
      if (!all) continue;

      if (st.located.includes(moduleId)) continue; // same module registered twice
      if (!st.def.all && st.located.length > 0) {
        issues.push(
          this.issue(st, "FIND_AMBIGUOUS", {
            moduleId,
            message:
              `find anchors ${st.finds.map(printableMatcher).join(" + ")} matched more than one module ` +
              `(${[...st.located, moduleId].join(", ")}). Make the anchors more specific, or set all: true.`,
          }),
        );
        continue;
      }
      st.located.push(moduleId);

      // 2. Replace, atomically per patch.
      let next = code;
      let ok = true;
      const reps = st.def.replacements ?? [];
      const repAnchors = st.anchors.filter((a) => a.kind === "replacement");
      for (let i = 0; i < reps.length; i++) {
        const rep = reps[i]!;
        if (!testerFor(rep.match)(next)) {
          issues.push(
            this.issue(st, "REPLACEMENT_NO_MATCH", {
              moduleId,
              anchor: printableMatcher(rep.match),
              message:
                `module ${moduleId} matched the find anchors, but replacement #${i} anchor ` +
                `${printableMatcher(rep.match)} did not occur in it. No replacement of this patch was applied.`,
            }),
          );
          ok = false;
          break;
        }
        const matcher = typeof rep.match === "string" ? rep.match : freshRegExp(rep.match);
        next = next.replace(matcher as any, this.expandReplace(st.plugin, rep.replace) as any);
      }
      if (!ok) continue;

      if (next !== code && validate) {
        const err = validate(next);
        if (err) {
          issues.push(
            this.issue(st, "COMPILE_ERROR", {
              moduleId,
              message: `patched source of module ${moduleId} failed to compile, patch reverted: ${err.message}`,
            }),
          );
          continue;
        }
      }
      for (const a of repAnchors) this.hit(a, moduleId);
      code = next;
      st.applied.push(moduleId);
      applied.push(st.def.id);
      if (st.def.onExports) captures.push(this.capturePoint(st));
    }
    return { code, changed: code !== source, applied, captures, issues };
  }

  /** Snapshot of every patch and anchor. `final` turns "not found" into failures. */
  report(opts: { final?: boolean; lazyIsFinal?: boolean } = {}): PatchReport {
    const final = opts.final ?? false;
    const entries: PatchReportEntry[] = this.states.map((st) => {
      const issues = [...st.issues];
      const unresolvedCounts = final && (opts.lazyIsFinal || !st.def.lazy);
      if (st.located.length === 0 && unresolvedCounts) {
        const missing = st.anchors.filter((a) => a.kind === "find" && a.hits === 0).map((a) => a.anchor);
        const detail = missing.length
          ? `find anchor(s) ${missing.join(", ")} occurred in no module`
          : `each find anchor occurred somewhere, but never all in the same module`;
        issues.push(
          this.makeIssue(st, "FIND_UNRESOLVED", {
            message: `${detail} (scanned ${this.seenModules.size} modules).`,
          }),
        );
      }
      const failed = issues.length > 0;
      const status: PatchStatus = failed ? "failed" : st.applied.length > 0 ? "applied" : "pending";
      return {
        plugin: st.plugin,
        patchId: st.def.id,
        optional: !!st.def.optional,
        lazy: !!st.def.lazy,
        ...(st.def.note ? { note: st.def.note } : {}),
        status,
        located: [...st.located],
        applied: [...st.applied],
        anchors: st.anchors.map((a) => ({ ...a, modules: [...a.modules] })),
        issues,
      };
    });
    const all = entries.flatMap((e) => e.issues);
    const failures = all.filter((i) => !i.optional);
    const warnings = all.filter((i) => i.optional);
    return { ok: failures.length === 0, final, modulesSeen: this.seenModules.size, entries, failures, warnings };
  }

  // -------------------------------------------------------------------------

  private capturePoint(st: PatchRuntimeState): CapturePoint {
    return {
      patchId: st.def.id,
      run: (exports, moduleId) => {
        try {
          if (st.def.onExports!(exports, moduleId) === false) {
            this.issue(st, "EXPORTS_UNRECOGNIZED", {
              moduleId,
              message: `module ${moduleId} matched the find anchors, but its exports did not have the expected shape.`,
            });
          }
        } catch (err) {
          this.issue(st, "EXPORTS_HANDLER_ERROR", {
            moduleId,
            message: `onExports threw for module ${moduleId}: ${(err as Error)?.message ?? String(err)}`,
          });
        }
      },
    };
  }

  private expandReplace(plugin: string, replace: string | ReplaceFn): string | ReplaceFn {
    const self = this.selfExpr(plugin);
    if (typeof replace === "string") return replace.replaceAll("$self", self);
    return (...args: any[]) => (replace as ReplaceFn)(...(args as [string])).replaceAll("$self", self);
  }

  private hit(a: AnchorState, moduleId: string): void {
    if (a.modules.includes(moduleId)) return;
    a.hits++;
    if (a.modules.length < this.maxModules) a.modules.push(moduleId);
  }

  private makeIssue(
    st: PatchRuntimeState,
    code: IssueCode,
    extra: { moduleId?: string; anchor?: string; message: string },
  ): PatchIssue {
    return {
      code,
      plugin: st.plugin,
      patchId: st.def.id,
      optional: !!st.def.optional,
      ...(extra.moduleId !== undefined ? { moduleId: extra.moduleId } : {}),
      ...(extra.anchor !== undefined ? { anchor: extra.anchor } : {}),
      message: `[${st.def.id}] ${code}: ${extra.message}`,
    };
  }

  private issue(
    st: PatchRuntimeState,
    code: IssueCode,
    extra: { moduleId?: string; anchor?: string; message: string },
  ): PatchIssue {
    const issue = this.makeIssue(st, code, extra);
    st.issues.push(issue);
    this.onIssue?.(issue);
    return issue;
  }
}

/** Human-readable multi-line report. */
export function formatReport(report: PatchReport): string {
  const lines: string[] = [];
  const mark = { applied: "OK  ", pending: "WAIT", failed: "FAIL" } as const;
  lines.push(
    `plexweb-mods anchor report (${report.final ? "final" : "interim"}): ` +
      `${report.entries.length} patches, ${report.modulesSeen} modules scanned, ` +
      `${report.failures.length} failures, ${report.warnings.length} warnings`,
  );
  for (const e of report.entries) {
    const flags = [e.optional ? "optional" : "required", e.lazy ? "lazy" : ""].filter(Boolean).join(", ");
    lines.push(`  ${e.status === "failed" && e.optional ? "WARN" : mark[e.status]} ${e.patchId} (${flags})`);
    if (e.note) lines.push(`         note: ${e.note}`);
    for (const a of e.anchors) {
      const where = a.hits ? `resolved in ${a.hits} module(s): ${a.modules.join(", ")}${a.hits > a.modules.length ? ", ..." : ""}` : "not resolved";
      lines.push(`         ${a.kind}[${a.index}] ${a.anchor} -> ${where}`);
    }
    for (const i of e.issues) lines.push(`         ${i.optional ? "warning" : "ERROR"}: ${i.message}`);
  }
  return lines.join("\n");
}

export class AnchorResolutionError extends Error {
  readonly report: PatchReport;
  constructor(report: PatchReport) {
    super(`${report.failures.length} required anchor failure(s):\n${report.failures.map((f) => `  - ${f.message}`).join("\n")}`);
    this.name = "AnchorResolutionError";
    this.report = report;
  }
}

export function assertResolved(report: PatchReport): void {
  if (!report.ok) throw new AnchorResolutionError(report);
}
