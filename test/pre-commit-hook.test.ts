// Runs the real .githooks/pre-commit against fake node/npm/gitleaks binaries
// and a fake nvm.sh, to pin down how it finds a usable Node when a GUI git
// client runs it without the user's shell setup.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = join(import.meta.dirname, "..");
const hook = join(root, ".githooks", "pre-commit");

function script(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

/** A bin dir with node (printing `version`), npm and gitleaks that log their calls. */
function fakeBin(dir: string, label: string, version: string | null): string {
  mkdirSync(dir, { recursive: true });
  if (version) script(join(dir, "node"), `echo ${version}`);
  script(join(dir, "npm"), `echo "${label}-npm $*" >> "$HOOK_LOG"`);
  script(join(dir, "gitleaks"), `echo "${label}-gitleaks $1" >> "$HOOK_LOG"`);
  script(join(dir, "git"), "exit 0"); // nothing staged under local/
  return dir;
}

interface Setup {
  /** Node version on the starting PATH, or null for none. */
  pathNode: string | null;
  /** Whether an nvm.sh exists (it puts a Node 22 bin dir first on PATH). */
  nvm: boolean;
  /** Put nvm in $NVM_DIR instead of ~/.nvm. */
  nvmDir?: boolean;
}

function runHook({ pathNode, nvm, nvmDir }: Setup) {
  const tmp = mkdtempSync(join(tmpdir(), "pre-commit-hook-"));
  const home = join(tmp, "home");
  const log = join(tmp, "calls.log");
  const startBin = fakeBin(join(tmp, "start-bin"), "start", pathNode);
  const nvmBin = fakeBin(join(tmp, "nvm-bin"), "nvm", "v22.23.4");
  const nvmHome = nvmDir ? join(tmp, "custom-nvm") : join(home, ".nvm");
  mkdirSync(home, { recursive: true });
  if (nvm) {
    mkdirSync(nvmHome, { recursive: true });
    // Like the real nvm.sh under dash: it only switches Node when NVM_DIR is
    // exported and points at its own directory (no BASH_SOURCE to find it).
    writeFileSync(
      join(nvmHome, "nvm.sh"),
      `echo sourced >> "$HOOK_LOG"\n` +
        `if [ "$(/bin/sh -c 'echo "\${NVM_DIR:-}"')" = "${nvmHome}" ]; then PATH="${nvmBin}:$PATH"; export PATH; fi\n`,
    );
  }
  const env: Record<string, string> = { HOME: home, PATH: startBin, HOOK_LOG: log };
  if (nvmDir) env.NVM_DIR = nvmHome;
  const res = spawnSync(hook, [], { cwd: tmp, env, encoding: "utf8" });
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, calls };
}

describe(".githooks/pre-commit Node resolution", () => {
  it.each([
    ["an old Node", "v12.22.9"],
    ["no Node", null],
  ])("loads ~/.nvm/nvm.sh when PATH has %s, then runs gitleaks, lint and tests with it", (_, pathNode) => {
    const r = runHook({ pathNode, nvm: true });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/pre-commit: node v22\.23\.4 \(.*nvm-bin\/node\)/);
    expect(r.calls).toEqual(["sourced", "nvm-gitleaks git", "nvm-npm run --silent lint", "nvm-npm test --silent"]);
  });

  it("honours $NVM_DIR", () => {
    const r = runHook({ pathNode: "v12.22.9", nvm: true, nvmDir: true });
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls[0]).toBe("sourced");
  });

  it("leaves PATH alone when its Node is new enough", () => {
    const r = runHook({ pathNode: "v24.1.0", nvm: true });
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).toEqual(["start-gitleaks git", "start-npm run --silent lint", "start-npm test --silent"]);
  });

  it.each(["v22.11.0", "v21.9.0", "v12.22.9"])("rejects %s with a clear message when nvm is absent", (v) => {
    const r = runHook({ pathNode: v, nvm: false });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`Node >= 22.12 is required (found: ${v})`);
    expect(r.calls).toEqual([]);
  });

  it("accepts exactly the minimum", () => {
    const r = runHook({ pathNode: "v22.12.0", nvm: false });
    expect(r.status, r.stderr).toBe(0);
  });

  it("uses the same minimum as package.json engines", () => {
    const engines = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).engines.node as string;
    const [, major, minor] = /^>=(\d+)\.(\d+)\.\d+$/.exec(engines)!;
    const text = readFileSync(hook, "utf8");
    expect(text).toContain(`NODE_MIN_MAJOR=${major}\n`);
    expect(text).toContain(`NODE_MIN_MINOR=${minor}\n`);
  });
});

/** Directory of the real git binary, for the tests that need a real repo. */
const gitDir = (process.env.PATH ?? "").split(":").find((d) => d && existsSync(join(d, "git")))!;

describe(".githooks/pre-commit local/ guard", () => {
  function repoWith(stage: (git: (...args: string[]) => void, write: (p: string, body: string) => void) => void) {
    const repo = mkdtempSync(join(tmpdir(), "pre-commit-local-"));
    const log = join(repo, "..", `${repo.split("/").pop()}.log`);
    const bin = fakeBin(join(repo, "..", `${repo.split("/").pop()}-bin`), "ok", "v22.23.4");
    rmSync(join(bin, "git")); // the guard needs the real git here
    const env = { HOME: repo, PATH: `${bin}:${gitDir}`, HOOK_LOG: log, GIT_CONFIG_NOSYSTEM: "1" };
    const git = (...args: string[]) => {
      const r = spawnSync("git", args, { cwd: repo, env, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    };
    const write = (p: string, body: string) => {
      mkdirSync(dirname(join(repo, p)), { recursive: true });
      writeFileSync(join(repo, p), body);
    };
    git("init", "-q");
    write(".gitignore", "/local/\n");
    stage(git, write);
    const res = spawnSync(hook, [], { cwd: repo, env, encoding: "utf8" });
    const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
    return { status: res.status, stderr: res.stderr, calls };
  }

  it("refuses force-added files under local/, empty ones included, before running anything else", () => {
    const r = repoWith((git, write) => {
      write("local/metalshop-notes.md", "notes\n");
      write("local/tools/empty.ts", "");
      git("add", "-f", "local/");
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("refusing to commit files under local/");
    expect(r.stderr).toContain("local/metalshop-notes.md\nlocal/tools/empty.ts\n");
    expect(r.calls).toEqual([]);
  });

  it("allows paths that only contain 'local' elsewhere in the tree", () => {
    const r = repoWith((git, write) => {
      write("docs/local/notes.md", "ok\n");
      write("test/local.test.ts", "ok\n");
      git("add", ".");
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).toEqual(["ok-gitleaks git", "ok-npm run --silent lint", "ok-npm test --silent"]);
  });

  it("allows deleting a file under local/ (cleaning up a past mistake)", () => {
    const r = repoWith((git, write) => {
      write("local/old.md", "x\n");
      git("add", "-f", "local/old.md");
      git("-c", "user.name=t", "-c", "user.email=t@test.invalid", "commit", "-q", "-m", "x");
      git("rm", "-q", "--cached", "local/old.md");
    });
    expect(r.status, r.stderr).toBe(0);
  });
});
