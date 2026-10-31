/**
 * Best-effort snapshot of a *public* Plex Web (e.g. https://app.plex.tv/desktop/)
 * or a server's /web/ into the gitignored bundle-snapshots/ dir, for anchor
 * research and version comparison.
 *
 * Limits: webpack composes lazy-chunk URLs at runtime, so only index.html, its
 * <script>/<link> assets and literally referenced same-origin .js files are
 * fetched. For a COMPLETE bundle, snapshot the server's copy instead:
 *   ./injector/reapply.sh --snapshot
 *
 * Usage: node dist/fetch-plex-web.cjs --url <url> [--out bundle-snapshots/<name>]
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface SnapshotResult {
  outDir: string;
  files: string[];
  failed: Array<{ url: string; reason: string }>;
}

type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export function assetRefs(html: string): string[] {
  const refs: string[] = [];
  for (const m of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)) refs.push(m[1]!);
  for (const m of html.matchAll(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi)) {
    if (/\brel=["']?(stylesheet|preload|modulepreload|manifest)/i.test(m[0])) refs.push(m[1]!);
  }
  return refs;
}

export function jsRefs(code: string): string[] {
  return [...new Set([...code.matchAll(/["']((?:\.{0,2}\/)?[\w./-]+\.js)["']/g)].map((m) => m[1]!))];
}

export async function snapshotFromUrl(opts: { url: string; outDir: string; fetchImpl?: FetchLike; maxFiles?: number; log?: (s: string) => void }): Promise<SnapshotResult> {
  if (!/(^|[\\/])bundle-snapshots[\\/]/.test(opts.outDir)) throw new Error(`--out must be inside bundle-snapshots/ (gitignored), got ${opts.outDir}`);
  if (existsSync(opts.outDir)) throw new Error(`${opts.outDir} already exists`);
  const f: FetchLike = opts.fetchImpl ?? ((u) => fetch(u));
  const log = opts.log ?? (() => {});
  const max = opts.maxFiles ?? 400;
  const base = new URL(opts.url.endsWith("/") || /\.html?$/.test(opts.url) ? opts.url : `${opts.url}/`);
  const indexUrl = /\.html?$/.test(base.pathname) ? base : new URL("index.html", base);
  const root = new URL(".", indexUrl);
  const files: string[] = [];
  const failed: SnapshotResult["failed"] = [];

  const save = (u: URL, body: string) => {
    const rel = decodeURIComponent(u.pathname.slice(root.pathname.length)) || "index.html";
    if (rel.includes("..")) throw new Error(`refusing path ${rel}`);
    const p = join(opts.outDir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
    files.push(rel);
  };

  const first = await f(indexUrl.href);
  if (!first.ok) throw new Error(`GET ${indexUrl.href}: HTTP ${first.status}`);
  const html = await first.text();
  mkdirSync(opts.outDir, { recursive: true });
  save(indexUrl, html);

  const queue: URL[] = [];
  const seen = new Set<string>([indexUrl.href]);
  const enqueue = (ref: string, from: URL) => {
    let u: URL;
    try {
      u = new URL(ref, from);
    } catch {
      return;
    }
    u.search = "";
    u.hash = "";
    if (u.origin !== root.origin || !u.pathname.startsWith(root.pathname) || seen.has(u.href)) return;
    seen.add(u.href);
    queue.push(u);
  };
  assetRefs(html).forEach((r) => enqueue(r, indexUrl));

  while (queue.length && files.length < max) {
    const u = queue.shift()!;
    try {
      const res = await f(u.href);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.text();
      save(u, body);
      log(`fetched ${u.pathname}`);
      if (u.pathname.endsWith(".js")) jsRefs(body).forEach((r) => enqueue(r, root));
    } catch (err) {
      failed.push({ url: u.href, reason: (err as Error).message });
    }
  }
  return { outDir: opts.outDir, files, failed };
}

async function main() {
  const args = process.argv.slice(2);
  let url: string | undefined;
  let out: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--url") url = args[++i];
    else if (args[i] === "--out") out = args[++i];
    else {
      console.error("usage: fetch-plex-web --url <url> [--out bundle-snapshots/<name>]");
      process.exit(2);
    }
  }
  if (!url) {
    console.error("usage: fetch-plex-web --url <url> [--out bundle-snapshots/<name>]");
    process.exit(2);
  }
  const host = new URL(url).hostname.replace(/[^\w.-]/g, "_");
  const outDir = resolve(out ?? join(dirname(__dirname), "bundle-snapshots", `${host}-${new Date().toISOString().slice(0, 10)}`));
  try {
    const r = await snapshotFromUrl({ url, outDir, log: (s) => console.log(s) });
    console.log(`saved ${r.files.length} file(s) to ${r.outDir}; ${r.failed.length} failed`);
    for (const x of r.failed) console.log(`  failed: ${x.url} (${x.reason})`);
    console.log(`next: node dist/preflight.cjs --bundle-dir ${r.outDir}`);
  } catch (err) {
    const e = err as Error & { cause?: Error };
    console.error(`fetch-plex-web: ${e.message}${e.cause ? ` (${e.cause.message})` : ""}`);
    process.exit(1);
  }
}

if (require.main === module) void main();
