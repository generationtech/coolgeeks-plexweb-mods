import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reapply } from "../injector/reapply";
import { LocalFs } from "../injector/target-fs";
import { findInBundle, formatFind } from "../preflight/preflight";
import { assetRefs, jsRefs, snapshotFromUrl } from "../tools/fetch-plex-web";
import { bundleFixture } from "./helpers/realm";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

describe("preflight --find", () => {
  it("lists module ids, files and counts (never code) and the intersection", () => {
    const r = findInBundle(bundleFixture("wp5"), ["Play Next", "Add to Up Next", "playQueueID"]);
    expect(r[0]).toEqual({ needle: "Play Next", modules: [{ id: "300", file: "js/vendor.js", count: 1 }] });
    expect(r[2]!.modules.map((m) => m.id)).toEqual(["301"]);
    const text = formatFind(r);
    expect(text).toMatch(/"Play Next": 1 module\(s\)\n {2}300 \(js\/vendor\.js\) x1/);
    expect(text).toMatch(/modules containing ALL of them: \(none\)/);
    expect(text).not.toMatch(/=>|function/);
  });
});

describe("injector --snapshot", () => {
  it("copies the Plex Web dir into bundle-snapshots/ and refuses other destinations", async () => {
    const webDir = tmp("web-");
    cpSync(bundleFixture("wp5"), webDir, { recursive: true });
    const dest = join(tmp("repo-"), "bundle-snapshots", "local-test");
    const base = { fs: new LocalFs(), installType: "linux" as const, webDir, runtimePath: "/unused" };
    const ok = await reapply({ ...base, mode: "snapshot", snapshotDir: dest });
    expect(ok.exitCode).toBe(0);
    expect(readFileSync(join(dest, "js", "vendor.js"), "utf8")).toBe(readFileSync(join(webDir, "js", "vendor.js"), "utf8"));
    const again = await reapply({ ...base, mode: "snapshot", snapshotDir: dest });
    expect(again.messages.at(-1)).toMatch(/already exists/);
    const outside = await reapply({ ...base, mode: "snapshot", snapshotDir: join(tmp("x-"), "elsewhere") });
    expect(outside.exitCode).toBe(1);
    expect(outside.messages.at(-1)).toMatch(/must be inside a bundle-snapshots\/ directory/);
  });
});

describe("fetch-plex-web", () => {
  it("parses asset and literal .js references", () => {
    expect(assetRefs('<script defer src="js/a.js"></script><link rel="stylesheet" href="css/b.css"><link rel="icon" href="x.ico">')).toEqual([
      "js/a.js",
      "css/b.css",
    ]);
    expect(jsRefs('x("js/lazy.js");y="https://cdn.example/other.js";z=\'./c.js\'')).toEqual(["js/lazy.js", "./c.js"]);
  });

  it("snapshots index.html, its assets and literally referenced chunks from a URL", async () => {
    const site = tmp("site-");
    mkdirSync(join(site, "desktop", "js"), { recursive: true });
    writeFileSync(join(site, "desktop", "index.html"), '<html><head><script src="js/main.js?v=1"></script><script src="https://cdn.example/x.js"></script></head></html>');
    writeFileSync(join(site, "desktop", "js", "main.js"), 'load("js/lazy.js");load("js/missing.js")');
    writeFileSync(join(site, "desktop", "js", "lazy.js"), "lazy");
    const server = createServer((req, res) => {
      const p = join(site, decodeURIComponent(new URL(req.url!, "http://x").pathname));
      if (existsSync(p) && !p.endsWith("/")) res.end(readFileSync(p));
      else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const outDir = join(tmp("repo-"), "bundle-snapshots", "public");
      const r = await snapshotFromUrl({ url: `http://127.0.0.1:${port}/desktop/`, outDir });
      expect(r.files.sort()).toEqual(["index.html", "js/lazy.js", "js/main.js"]);
      expect(r.failed.map((f) => f.reason)).toEqual(["HTTP 404"]);
      await expect(snapshotFromUrl({ url: `http://127.0.0.1:${port}/desktop/`, outDir: join(tmp("y-"), "not-snapshots") })).rejects.toThrow(/bundle-snapshots/);
      await expect(snapshotFromUrl({ url: `http://127.0.0.1:${port}/nope/`, outDir: join(tmp("z-"), "bundle-snapshots", "n") })).rejects.toThrow(/HTTP 404/);
    } finally {
      server.close();
    }
  });
});
