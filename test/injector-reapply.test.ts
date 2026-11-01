import { beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { injectedVersion } from "../injector/html";
import { BACKUP_SUFFIX, contentVersion, reapply, type ReapplyOptions } from "../injector/reapply";
import { DockerFs, LocalFs, PodmanFs, type ContainerFlags, type Exec } from "../injector/target-fs";
import { detectChunkGlobalsInDir } from "../preflight/extract";
import { formatPreflight, runPreflight } from "../preflight/preflight";
import type { PluginDef } from "../runtime/types";
import { bundleFixture } from "./helpers/realm";

const root = join(import.meta.dirname, "..");
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

/** A Plex-like install tree with Plex Web at the usual relative location. */
function fakeInstall(): { installRoot: string; webDir: string; runtimePath: string } {
  const installRoot = tmp("pms-");
  const webDir = join(installRoot, "usr/lib/plexmediaserver/Resources/Plug-ins-test/WebClient.bundle/Contents/Resources");
  mkdirSync(webDir, { recursive: true });
  cpSync(bundleFixture("wp5"), webDir, { recursive: true });
  const runtimePath = join(tmp("dist-"), "plexweb-mods.js");
  writeFileSync(runtimePath, "/* fake runtime v1 */");
  return { installRoot, webDir, runtimePath };
}

const resolvable: PluginDef[] = [{ name: "t", description: "", patches: [{ id: "t/menu", find: '"Add to Up Next"', onExports: () => {} }] }];
const unresolvable: PluginDef[] = [{ name: "t", description: "", patches: [{ id: "t/x", find: "Not In This Bundle", onExports: () => {} }] }];

function opts(over: Partial<ReapplyOptions> & Pick<ReapplyOptions, "fs" | "runtimePath">): ReapplyOptions {
  return {
    mode: "apply",
    installType: "linux",
    preflight: (dir) => runPreflight(dir, resolvable),
    formatPreflight,
    detectChunkGlobals: detectChunkGlobalsInDir,
    ...over,
  };
}

describe("reapply on a local Linux-style install", () => {
  it("applies with backup + cache-busted tag, is idempotent, and uninstalls cleanly", async () => {
    const { webDir, runtimePath } = fakeInstall();
    const pristine = readFileSync(join(webDir, "index.html"), "utf8");
    const fs = new LocalFs();

    const first = await reapply(opts({ fs, runtimePath, webDir }));
    expect(first.exitCode).toBe(0);
    expect(first.changed).toBe(true);
    const html = readFileSync(join(webDir, "index.html"), "utf8");
    expect(injectedVersion(html)).toBe(contentVersion("/* fake runtime v1 */"));
    expect(html).toContain('data-chunk-globals="webpackChunkfake_plex"');
    expect(html.indexOf("plexweb-mods.js")).toBeLessThan(html.indexOf('src="js/vendor.js"'));
    expect(readFileSync(join(webDir, "index.html" + BACKUP_SUFFIX), "utf8")).toBe(pristine);
    expect(readFileSync(join(webDir, "plexweb-mods.js"), "utf8")).toBe("/* fake runtime v1 */");
    expect(first.messages.join("\n")).toMatch(/verified: index.html references plexweb-mods.js\?v=/);

    const second = await reapply(opts({ fs, runtimePath, webDir }));
    expect(second.changed).toBe(false);
    expect(second.messages.at(-1)).toMatch(/already applied and up to date/);
    expect(readFileSync(join(webDir, "index.html"), "utf8")).toBe(html);

    // new build -> new cache-busting version, same single block
    writeFileSync(runtimePath, "/* fake runtime v2 */");
    const third = await reapply(opts({ fs, runtimePath, webDir, skipPreflight: true }));
    expect(third.changed).toBe(true);
    const html3 = readFileSync(join(webDir, "index.html"), "utf8");
    expect(injectedVersion(html3)).toBe(contentVersion("/* fake runtime v2 */"));
    expect(html3.match(/plexweb-mods:begin/g)).toHaveLength(1);
    expect(html3).toContain('data-chunk-globals="webpackChunkfake_plex"'); // still detected without preflight

    const un = await reapply(opts({ fs, runtimePath, webDir, mode: "uninstall" }));
    expect(un.exitCode).toBe(0);
    expect(readFileSync(join(webDir, "index.html"), "utf8")).toBe(pristine);
    expect(existsSync(join(webDir, "plexweb-mods.js"))).toBe(false);
    expect(existsSync(join(webDir, "index.html" + BACKUP_SUFFIX))).toBe(false);
  });

  it("dry-run reports a diff and changes nothing", async () => {
    const { webDir, runtimePath } = fakeInstall();
    const before = readdirSync(webDir).map((f) => [f, statSync(join(webDir, f)).mtimeMs]);
    const r = await reapply(opts({ fs: new LocalFs(), runtimePath, webDir, dryRun: true }));
    expect(r.exitCode).toBe(0);
    expect(r.messages.join("\n")).toMatch(/\[dry-run\] insert script tag/);
    expect(r.messages.join("\n")).toMatch(/^\+ .*plexweb-mods:begin/m);
    expect(readdirSync(webDir).map((f) => [f, statSync(join(webDir, f)).mtimeMs])).toEqual(before);
  });

  it("is gated by preflight (exit 3, no changes) unless --force", async () => {
    const { webDir, runtimePath } = fakeInstall();
    const pristine = readFileSync(join(webDir, "index.html"), "utf8");
    const gated = await reapply(opts({ fs: new LocalFs(), runtimePath, webDir, preflight: (d) => runPreflight(d, unresolvable) }));
    expect(gated.exitCode).toBe(3);
    expect(gated.messages.join("\n")).toMatch(/\[t\/x\] FIND_UNRESOLVED/);
    expect(readFileSync(join(webDir, "index.html"), "utf8")).toBe(pristine);
    expect(existsSync(join(webDir, "plexweb-mods.js"))).toBe(false);

    const forced = await reapply(opts({ fs: new LocalFs(), runtimePath, webDir, force: true, preflight: (d) => runPreflight(d, unresolvable) }));
    expect(forced.exitCode).toBe(0);
    expect(forced.messages.join("\n")).toMatch(/--force was given/);
  });

  it("detects a Plex update (fresh index.html) and refreshes the backup", async () => {
    const { webDir, runtimePath } = fakeInstall();
    const fs = new LocalFs();
    await reapply(opts({ fs, runtimePath, webDir }));
    const updated = "<!DOCTYPE html><html><head><script src=js/new.js></script></head></html>";
    writeFileSync(join(webDir, "index.html"), updated); // PMS update overwrote index.html
    const r = await reapply(opts({ fs, runtimePath, webDir, skipPreflight: true }));
    expect(r.messages.join("\n")).toMatch(/changed since the last apply \(Plex update\?\); refreshing the backup/);
    expect(readFileSync(join(webDir, "index.html" + BACKUP_SUFFIX), "utf8")).toBe(updated);
  });

  it("auto-discovers Plex Web when PLEX_WEB_DIR is unset", async () => {
    const { installRoot, webDir, runtimePath } = fakeInstall();
    // point the search root at the fake install via a LocalFs subclass
    class Rooted extends LocalFs {
      override findPlexWebIndex(r: string) {
        return super.findPlexWebIndex(join(installRoot, r));
      }
    }
    const r = await reapply(opts({ fs: new Rooted(), runtimePath, mode: "status" }));
    expect(r.exitCode).toBe(0);
    expect(r.webDir).toBe(webDir);
    expect(r.messages.join("\n")).toMatch(/index.html: pristine/);
  });

  it("fails clearly on a wrong PLEX_WEB_DIR or a missing build", async () => {
    const { webDir } = fakeInstall();
    const bad = await reapply(opts({ fs: new LocalFs(), runtimePath: "/nope.js", webDir: "/definitely/not/plex" }));
    expect(bad.exitCode).toBe(1);
    expect(bad.messages.at(-1)).toMatch(/no index.html in PLEX_WEB_DIR=\/definitely\/not\/plex/);
    const nobuild = await reapply(opts({ fs: new LocalFs(), runtimePath: "/nope.js", webDir }));
    expect(nobuild.messages.at(-1)).toMatch(/runtime not built/);
  });

  it("warns about service workers and verifies over HTTP when asked", async () => {
    const { webDir, runtimePath } = fakeInstall();
    writeFileSync(join(webDir, "sw.js"), "");
    const served = (path: string) => readFileSync(join(webDir, path.replace(/^\/web\//, "").replace(/\?.*$/, "")), "utf8");
    const fetchImpl = async (url: string) => {
      const body = served(new URL(url).pathname + new URL(url).search);
      return { ok: true, status: 200, text: async () => body, headers: { get: () => "no-cache" } };
    };
    const r = await reapply(opts({ fs: new LocalFs(), runtimePath, webDir, verifyUrl: "http://plex-server.example:32400", fetchImpl }));
    const text = r.messages.join("\n");
    expect(text).toMatch(/WARNING: sw.js exists/);
    expect(text).toMatch(/HTTP verify: index.html served with the new tag \(Cache-Control: no-cache\)/);
    expect(text).toMatch(/HTTP verify: runtime served and matches the build/);
  });

  it("--verify-served checks over HTTP only, never touching a filesystem", async () => {
    const { webDir, runtimePath } = fakeInstall();
    await reapply(opts({ fs: new LocalFs(), runtimePath, webDir }));
    const served = (path: string) => readFileSync(join(webDir, path.replace(/^\/web\//, "")), "utf8");
    const fetchImpl = async (url: string) => {
      const body = served(new URL(url).pathname);
      return { ok: true, status: 200, text: async () => body, headers: { get: () => "no-cache" } };
    };
    const noFs = new Proxy({} as LocalFs, { get: (_, k) => () => Promise.reject(new Error(`fs.${String(k)} called`)) });
    const ok = await reapply(opts({ fs: noFs, runtimePath, mode: "verify", verifyUrl: "https://plex-server.example:32400", fetchImpl }));
    expect(ok.exitCode, ok.messages.join("\n")).toBe(0);
    expect(ok.messages.join("\n")).toMatch(/runtime served and matches the build[\s\S]*the served Plex Web carries this build/);

    writeFileSync(runtimePath, "/* fake runtime v2, not deployed */");
    const stale = await reapply(opts({ fs: noFs, runtimePath, mode: "verify", verifyUrl: "https://plex-server.example:32400", fetchImpl }));
    expect(stale.exitCode).toBe(1);
    expect(stale.messages.at(-1)).toMatch(/does not reference plexweb-mods\.js\?v=/);
  });
});

/**
 * Emulates `docker|podman exec/cp/inspect` against a directory standing in
 * for the container's filesystem, so the container code path runs end to end.
 * A read-only container refuses `cp` into it, like the real engines.
 */
function fakeDocker(
  containerRoot: string,
  name = "plex",
  engine: "docker" | "podman" = "docker",
  flags: ContainerFlags = { readOnly: false, autoRemove: false },
): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const inC = (p: string) => join(containerRoot, p);
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
    const err = (stderr: string) => ({ code: 1, stdout: "", stderr });
    if (cmd !== engine) return err(`not ${engine}`);
    const [sub, ...rest] = args;
    if (sub === "inspect") return rest.at(-1) === name ? ok(`${flags.readOnly} ${flags.autoRemove}\n`) : err(`no such container ${rest.at(-1)}`);
    if (sub === "exec") {
      const [c, prog, ...pargs] = rest;
      if (c !== name) return err(`No such container: ${c}`);
      if (prog === "test") return existsSync(inC(pargs[1]!)) ? ok() : { code: 1, stdout: "", stderr: "" };
      if (prog === "cat") return existsSync(inC(pargs[0]!)) ? ok(readFileSync(inC(pargs[0]!), "utf8")) : err("No such file");
      if (prog === "rm") return rmSync(inC(pargs[1]!), { force: true }), ok();
      if (prog === "find") {
        const found: string[] = [];
        const walk = (d: string) => {
          if (!existsSync(d)) return;
          for (const e of readdirSync(d, { withFileTypes: true })) {
            const p = join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (p.endsWith("/WebClient.bundle/Contents/Resources/index.html")) found.push(p.slice(containerRoot.length));
          }
        };
        walk(inC(pargs[0]!));
        return ok(found.join("\n") + "\n");
      }
    }
    if (sub === "cp") {
      const [src, dst] = rest as [string, string];
      if (dst.startsWith(`${name}:`) && flags.readOnly) return err("read-only file system");
      if (dst.startsWith(`${name}:`)) {
        copyFileSync(src, inC(dst.slice(name.length + 1)));
        return ok();
      }
      if (src.startsWith(`${name}:`)) {
        const from = inC(src.slice(name.length + 1));
        cpSync(from, join(dst, from.split("/").pop()!), { recursive: true });
        return ok();
      }
    }
    return err(`unsupported: ${args.join(" ")}`);
  };
  return { exec, calls };
}

describe("reapply against a Docker container", () => {
  it("discovers, applies and uninstalls through docker exec/cp", async () => {
    const { installRoot, webDir, runtimePath } = fakeInstall();
    const { exec, calls } = fakeDocker(installRoot);
    const fs = new DockerFs("plex", exec);
    const pristine = readFileSync(join(webDir, "index.html"), "utf8");

    const r = await reapply(opts({ fs, runtimePath, installType: "docker" }));
    expect(r.exitCode).toBe(0);
    expect(r.webDir).toBe("/usr/lib/plexmediaserver/Resources/Plug-ins-test/WebClient.bundle/Contents/Resources");
    expect(r.messages.join("\n")).toMatch(/target: docker container "plex" \(docker\)/);
    expect(readFileSync(join(webDir, "index.html"), "utf8")).toContain("plexweb-mods.js?v=");
    expect(readFileSync(join(webDir, "plexweb-mods.js"), "utf8")).toBe("/* fake runtime v1 */");
    expect(calls.some((c) => c[1] === "cp" && c[3]?.startsWith("plex:") && c[3].endsWith("/plexweb-mods.js"))).toBe(true);
    expect(calls.some((c) => c[1] === "exec" && c[3] === "find")).toBe(true);

    const again = await reapply(opts({ fs, runtimePath, installType: "docker" }));
    expect(again.changed).toBe(false);

    await reapply(opts({ fs, runtimePath, installType: "docker", mode: "uninstall" }));
    expect(readFileSync(join(webDir, "index.html"), "utf8")).toBe(pristine);
    expect(existsSync(join(webDir, "plexweb-mods.js"))).toBe(false);
  });

  it("surfaces docker errors with the failing command", async () => {
    const { installRoot, runtimePath } = fakeInstall();
    const { exec } = fakeDocker(installRoot, "other");
    const fs = new DockerFs("plex", exec);
    await expect(fs.readText("/x")).rejects.toThrow(/reading \/x failed \(docker exec plex cat \/x\): No such container: plex/);
    const r = await reapply(opts({ fs, runtimePath, installType: "docker" }));
    expect(r.exitCode).toBe(1);
    expect(r.messages.at(-1)).toMatch(/could not find Plex Web/);
  });

  it("rejects unsafe container names", () => {
    expect(() => new DockerFs("plex; rm -rf /")).toThrow(/invalid container name/);
    expect(() => new PodmanFs("$(id)")).toThrow(/invalid container name/);
  });
});

describe("reapply against a Podman container", () => {
  it("discovers, applies and uninstalls through podman exec/cp", async () => {
    const { installRoot, webDir, runtimePath } = fakeInstall();
    const { exec, calls } = fakeDocker(installRoot, "plex-test", "podman");
    const fs = new PodmanFs("plex-test", exec);
    const pristine = readFileSync(join(webDir, "index.html"), "utf8");

    const r = await reapply(opts({ fs, runtimePath, installType: "podman" }));
    expect(r.exitCode).toBe(0);
    expect(r.messages.join("\n")).toMatch(/target: podman container "plex-test" \(podman\)/);
    expect(readFileSync(join(webDir, "index.html"), "utf8")).toContain("plexweb-mods.js?v=");
    expect(calls.every((c) => c[0] === "podman")).toBe(true);
    expect(calls.some((c) => c[1] === "inspect")).toBe(true);

    await reapply(opts({ fs, runtimePath, installType: "podman", mode: "uninstall" }));
    expect(readFileSync(join(webDir, "index.html"), "utf8")).toBe(pristine);
  });

  it("refuses to apply or uninstall on a read-only root fs, pointing at the derived image; nothing is written", async () => {
    const { installRoot, webDir, runtimePath } = fakeInstall();
    const { exec, calls } = fakeDocker(installRoot, "plex", "podman", { readOnly: true, autoRemove: true });
    const fs = new PodmanFs("plex", exec);
    const pristine = readFileSync(join(webDir, "index.html"), "utf8");

    for (const mode of ["apply", "uninstall"] as const) {
      const r = await reapply(opts({ fs, runtimePath, installType: "podman", mode }));
      expect(r.exitCode).toBe(1);
      expect(r.messages.at(-1)).toMatch(/podman container "plex" has a read-only root filesystem.*derived image.*image\/Containerfile/);
    }
    expect(calls.some((c) => c[1] === "cp" && c[3]?.startsWith("plex:"))).toBe(false);
    expect(readFileSync(join(webDir, "index.html"), "utf8")).toBe(pristine);
    expect(existsSync(join(webDir, "index.html" + BACKUP_SUFFIX))).toBe(false);
  });

  it("only warns on --dry-run, and --status / --snapshot still work on a read-only container", async () => {
    const { installRoot, runtimePath } = fakeInstall();
    const { exec } = fakeDocker(installRoot, "plex", "podman", { readOnly: true, autoRemove: false });
    const fs = new PodmanFs("plex", exec);
    const dry = await reapply(opts({ fs, runtimePath, installType: "podman", dryRun: true }));
    expect(dry.exitCode).toBe(0);
    expect(dry.messages.join("\n")).toMatch(/WARNING: podman container "plex" has a read-only root filesystem/);
    const status = await reapply(opts({ fs, runtimePath, installType: "podman", mode: "status" }));
    expect(status.exitCode).toBe(0);
    expect(status.messages.join("\n")).toMatch(/index.html: pristine/);
    const snapRoot = tmp("snaps-");
    const snap = await reapply(opts({ fs, runtimePath, installType: "podman", mode: "snapshot", snapshotDir: join(snapRoot, "bundle-snapshots", "podman-x") }));
    expect(snap.exitCode).toBe(0);
    expect(existsSync(join(snapRoot, "bundle-snapshots", "podman-x", "index.html"))).toBe(true);
  });

  it("notes that a --rm container loses the change at its next start", async () => {
    const { installRoot, runtimePath } = fakeInstall();
    const { exec } = fakeDocker(installRoot, "plex", "podman", { readOnly: false, autoRemove: true });
    const r = await reapply(opts({ fs: new PodmanFs("plex", exec), runtimePath, installType: "podman" }));
    expect(r.exitCode).toBe(0);
    expect(r.messages.join("\n")).toMatch(/runs with --rm, so it is recreated from its image on every start.*derived image/);
  });

  it("carries on when inspect is unavailable (flags unknown)", async () => {
    const { installRoot, runtimePath } = fakeInstall();
    const { exec } = fakeDocker(installRoot, "plex", "podman");
    const noInspect: Exec = (cmd, args) => (args[0] === "inspect" ? Promise.resolve({ code: 125, stdout: "", stderr: "unknown" }) : exec(cmd, args));
    const r = await reapply(opts({ fs: new PodmanFs("plex", noInspect), runtimePath, installType: "podman" }));
    expect(r.exitCode).toBe(0);
  });
});

describe("CLI and shell wrapper", () => {
  let distDir: string;
  beforeAll(async () => {
    distDir = tmp("injector-dist-");
    await build({ entryPoints: [join(root, "injector/cli.ts")], bundle: true, platform: "node", format: "cjs", outfile: join(distDir, "injector.cjs"), logLevel: "silent" });
    writeFileSync(join(distDir, "plexweb-mods.js"), "/* cli runtime */");
  });
  const cli = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [join(distDir, "injector.cjs"), ...args], { encoding: "utf8", env: { PATH: process.env.PATH!, ...env } });

  it("applies (gated by the real plugin preflight) and reports exit codes", () => {
    const { webDir } = fakeInstall();
    const env = { PLEX_INSTALL_TYPE: "linux", PLEX_WEB_DIR: webDir };
    const gated = cli([], env);
    expect(gated.status).toBe(3); // the shipped native-player patch is not resolvable in the fake bundle
    expect(gated.stdout).toMatch(/play-from-here\/native-player/);
    const forced = cli(["--force", "--no-banner", "--opt", "pfh-companion=off"], env);
    expect(forced.status).toBe(0);
    const html = readFileSync(join(webDir, "index.html"), "utf8");
    expect(html).toContain('data-banner="off"');
    expect(html).toContain('data-opt-pfh-companion="off"');
    expect(cli(["--status"], env).stdout).toMatch(/index.html: injected/);
    expect(cli(["--uninstall"], env).status).toBe(0);
  });

  it("selects podman from PLEX_INSTALL_TYPE and the container from PLEX_CONTAINER (over PLEX_DOCKER_CONTAINER)", () => {
    const bin = tmp("fake-podman-");
    const log = join(bin, "calls.log");
    writeFileSync(join(bin, "podman"), `#!/bin/sh\necho "$*" >> "${log}"\nexit 1\n`, { mode: 0o755 });
    const env = { PATH: `${bin}:${process.env.PATH!}`, PLEX_INSTALL_TYPE: "podman", PLEX_CONTAINER: "plex-new", PLEX_DOCKER_CONTAINER: "plex-old" };
    const r = cli(["--status"], env);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/could not find Plex Web .* on podman container "plex-new"/);
    expect(readFileSync(log, "utf8")).toMatch(/^exec plex-new find \/usr\/lib\/plexmediaserver /m);
    const bad = cli(["--status", "--container", "x;y"], env);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/invalid container name/);
  });

  it("rejects bad usage with exit code 2", () => {
    expect(cli(["--bogus"]).status).toBe(2);
    expect(cli([], { PLEX_INSTALL_TYPE: "windows" }).status).toBe(2);
    expect(cli(["--verify"], { PLEX_WEB_DIR: "/x" }).status).toBe(2);
    expect(cli(["--verify-served"]).status).toBe(2);
    expect(cli(["--help"]).stdout).toMatch(/usage: reapply.sh/);
  });

  it("reapply.sh is valid POSIX sh and loads .env before running the injector", () => {
    expect(spawnSync("sh", ["-n", join(root, "injector/reapply.sh")]).status).toBe(0);
    // run a copy of the wrapper inside a scratch "repo" with a prebuilt dist/ and a .env
    const repo = tmp("wrapper-");
    mkdirSync(join(repo, "injector"));
    mkdirSync(join(repo, "dist"));
    copyFileSync(join(root, "injector/reapply.sh"), join(repo, "injector/reapply.sh"));
    copyFileSync(join(distDir, "injector.cjs"), join(repo, "dist/injector.cjs"));
    copyFileSync(join(distDir, "plexweb-mods.js"), join(repo, "dist/plexweb-mods.js"));
    const { webDir } = fakeInstall();
    writeFileSync(join(repo, ".env"), `PLEX_INSTALL_TYPE=linux\nPLEX_WEB_DIR=${webDir}\n`);
    const r = spawnSync("sh", [join(repo, "injector/reapply.sh"), "--status"], { encoding: "utf8", env: { PATH: process.env.PATH! } });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/index.html: pristine/);
    expect(r.stdout).toMatch(/backup: none/);
  });
});
