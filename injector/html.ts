/**
 * Pure index.html transforms: add / replace / remove exactly one marked
 * <script> block. The block goes before Plex Web's first <script> so the
 * runtime is installed before the webpack runtime executes.
 */

export const BEGIN_MARKER = "<!-- plexweb-mods:begin -->";
export const END_MARKER = "<!-- plexweb-mods:end -->";
export const RUNTIME_FILENAME = "plexweb-mods.js";

export interface TagOptions {
  /** Cache-busting version (content hash of the runtime file). */
  version: string;
  chunkGlobals?: readonly string[];
  banner?: boolean;
  reportDelayMs?: number;
  /** Extra plugin options -> data-opt-<key>="<value>". */
  options?: Record<string, string>;
  src?: string;
}

const escapeAttr = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function renderTag(o: TagOptions): string {
  if (!/^[A-Za-z0-9._-]+$/.test(o.version)) throw new Error(`invalid version "${o.version}"`);
  const attrs: string[] = [`src="${escapeAttr(o.src ?? RUNTIME_FILENAME)}?v=${o.version}"`];
  if (o.chunkGlobals?.length) attrs.push(`data-chunk-globals="${escapeAttr(o.chunkGlobals.join(","))}"`);
  if (o.banner === false) attrs.push(`data-banner="off"`);
  if (o.reportDelayMs !== undefined) attrs.push(`data-report-delay-ms="${Math.max(0, Math.floor(o.reportDelayMs))}"`);
  for (const [k, v] of Object.entries(o.options ?? {})) {
    if (!/^[a-z0-9-]+$/.test(k)) throw new Error(`invalid option name "${k}" (use lowercase letters, digits, dashes)`);
    attrs.push(`data-opt-${k}="${escapeAttr(v)}"`);
  }
  return `${BEGIN_MARKER}<script ${attrs.join(" ")}></script>${END_MARKER}`;
}

const BLOCK = /[ \t]*<!-- plexweb-mods:begin -->[\s\S]*?<!-- plexweb-mods:end -->[ \t]*\r?\n?/g;

export function hasInjection(html: string): boolean {
  return html.includes(BEGIN_MARKER);
}

/** The injected tag's version (?v=...), if present. */
export function injectedVersion(html: string): string | null {
  const block = html.slice(html.indexOf(BEGIN_MARKER), html.indexOf(END_MARKER));
  return /\?v=([A-Za-z0-9._-]+)"/.exec(block)?.[1] ?? null;
}

export function removeInjection(html: string): string {
  const begins = html.split(BEGIN_MARKER).length - 1;
  const ends = html.split(END_MARKER).length - 1;
  if (begins !== ends) throw new Error("index.html has unbalanced plexweb-mods markers; fix it by hand or restore the backup");
  return html.replace(BLOCK, "");
}

function commentRanges(html: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of html.matchAll(/<!--[\s\S]*?-->/g)) out.push([m.index!, m.index! + m[0].length]);
  return out;
}

export interface InjectResult {
  html: string;
  changed: boolean;
  position: "replaced" | "before-first-script" | "end-of-head";
}

/** Inserts (or replaces) the marked block. Idempotent. */
export function injectTag(html: string, tag: string): InjectResult {
  if (hasInjection(html)) {
    const base = removeInjection(html);
    const reinserted = injectTag(base, tag);
    return { html: reinserted.html, changed: reinserted.html !== html, position: "replaced" };
  }
  const comments = commentRanges(html);
  const inComment = (i: number) => comments.some(([a, b]) => i >= a && i < b);
  for (const m of html.matchAll(/<script\b/gi)) {
    if (inComment(m.index!)) continue;
    const i = m.index!;
    const lineStart = html.lastIndexOf("\n", i) + 1;
    const before = html.slice(lineStart, i);
    // On its own line (same indent) when Plex's tag starts a line; inline otherwise.
    const ownLine = /^[ \t]*$/.test(before);
    const insertAt = ownLine ? lineStart : i;
    const insertion = ownLine ? `${before}${tag}\n` : tag;
    return { html: html.slice(0, insertAt) + insertion + html.slice(insertAt), changed: true, position: "before-first-script" };
  }
  const head = /<\/head\s*>/i.exec(html);
  if (!head) throw new Error("index.html has neither a <script> nor a </head>; refusing to guess where to inject");
  return { html: html.slice(0, head.index) + tag + "\n" + html.slice(head.index), changed: true, position: "end-of-head" };
}

/** Tiny line diff for dry-run output. */
export function lineDiff(before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  const out: string[] = [`@@ line ${start + 1} @@`];
  for (let i = start; i <= endA; i++) out.push(`- ${a[i]}`);
  for (let i = start; i <= endB; i++) out.push(`+ ${b[i]}`);
  return out.length === 1 ? "(no changes)" : out.join("\n");
}
