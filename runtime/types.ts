/**
 * Public types for the patch engine and plugin definitions.
 *
 * A *patch* is located by one or more `find` anchors (every anchor must occur
 * in a module's source) and then rewrites that module's source with ordered,
 * string-anchored `replacements` (Vencord-style), and/or captures the
 * module's exports after it runs (`onExports`).
 */

/** An anchor: literal text (exact substring) or a regular expression. */
export type Matcher = string | RegExp;

export type ReplaceFn = (match: string, ...rest: any[]) => string;

export interface Replacement {
  /** Anchor that must occur in the (already partially patched) module source. */
  match: Matcher;
  /**
   * Replacement text (String.prototype.replace semantics: `$&`, `$1`, ...).
   * `$self` expands to an expression that evaluates to the owning plugin
   * object at runtime.
   */
  replace: string | ReplaceFn;
}

export interface PatchDef {
  /** Unique, stable id: "<plugin>/<what>". Used in every report line. */
  id: string;
  /** Module-selector anchors. A module is selected when it contains ALL of them. */
  find: Matcher | readonly Matcher[];
  /** Applied in order, atomically: if any anchor misses, none are applied. */
  replacements?: readonly Replacement[];
  /**
   * Called with `module.exports` after the selected module's factory ran.
   * Return `false` when the exports did not have the expected shape; the
   * engine reports that as a failure of this patch.
   */
  onExports?: (exports: unknown, moduleId: string) => boolean | void;
  /** Allow (and apply to) more than one matching module. Default: exactly one. */
  all?: boolean;
  /** Optional patches report problems as warnings instead of failures. */
  optional?: boolean;
  /**
   * The module may live in a lazily loaded chunk, so "not seen yet" at
   * page-load time is a warning at runtime (preflight still requires it).
   */
  lazy?: boolean;
  /** Free-form provenance note shown in reports (e.g. "unverified candidate"). */
  note?: string;
  /**
   * Marks a patch whose integration is not finished. Final reports (runtime
   * and preflight) list it as PATCH_INCOMPLETE even when every anchor
   * resolved, so an unfinished mod can never look green.
   */
  todo?: string;
}

/** API handed to a plugin's init() and start(). */
export interface PluginApi {
  /** The global runtime handle (window.__plexwebMods). */
  readonly mods: unknown;
  readonly log: Logger;
  readonly config: RuntimeConfig;
  /** Small on-page message (toast). */
  notify(message: string, level?: "info" | "error"): void;
}

export interface PluginDef {
  /** Stable name; also the key under which `$self` resolves. */
  readonly name: string;
  readonly description: string;
  readonly patches: readonly PatchDef[];
  /**
   * Runs synchronously when the runtime script executes, i.e. BEFORE Plex
   * Web's own scripts (browser only; never called by preflight). Use it to
   * install observers that must see Plex Web's first requests.
   */
  init?(api: PluginApi): void;
  /** Runs once the DOM is ready (browser only; never called by preflight). */
  start?(api: PluginApi): void | Promise<void>;
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface RuntimeConfig {
  /** Names of webpack chunk-loading globals to hook (e.g. "webpackChunkfoo"). */
  chunkGlobals: string[];
  /** Delay after window "load" before the anchor report is finalized. */
  reportDelayMs: number;
  /** Show an on-page banner when required anchors fail. */
  banner: boolean;
  debug: boolean;
  /** Free-form per-plugin options from data-* attributes (data-opt-<key>). */
  options: Record<string, string>;
}
