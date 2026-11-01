// Runs the real .githooks/pre-commit against fake node/npm/gitleaks binaries
// and a fake nvm.sh, to pin down how it finds a usable Node when a GUI git
// client runs it without the user's shell setup.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
