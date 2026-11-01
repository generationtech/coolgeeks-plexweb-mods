// Guards the public-repo rules in CLAUDE.md that can be checked mechanically.
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out.set(m[1]!, m[2]!);
  }
  return out;
}

describe(".env.example", () => {
  const env = parseEnv(read(".env.example"));

  it("declares every documented variable", () => {
    for (const key of ["PLEX_URL", "PLEX_TOKEN", "PLEX_SECTION_ID", "PLEX_INSTALL_TYPE", "PLEX_WEB_DIR"]) {
      expect(env.has(key), key).toBe(true);
    }
  });

  it("contains placeholders only", () => {
    expect(env.get("PLEX_TOKEN")).toMatch(/placeholder/i);
    const url = new URL(env.get("PLEX_URL")!);
    expect(url.hostname.endsWith(".example")).toBe(true);
    for (const value of env.values()) {
      expect(value).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
      expect(value).not.toMatch(/plex\.direct/i);
    }
  });
});

describe(".gitignore", () => {
  const ignored = (path: string) => {
    try {
      execFileSync("git", ["check-ignore", "-q", "--no-index", path], { cwd: root });
      return true;
    } catch {
      return false;
    }
  };

  it.each([
    ".env",
    ".env.local",
    "playwright/.auth/user.json",
    "e2e/storageState.json",
    "test-results/x/trace.zip",
    "capture.har",
    "screenshots/a.png",
    "videos/a.webm",
    "playwright-report/index.html",
    "Preferences.xml",
    "bundle-snapshots/web/index.html",
    "node_modules/x/index.js",
    "dist/plexweb-mods.js",
    "local/metalshop-plex.md",
    "local/metalshop-plex/plex.container",
    "local/tools/peek.cjs",
  ])("ignores %s", (p) => {
    expect(ignored(p)).toBe(true);
  });

  it("keeps .env.example tracked", () => {
    expect(ignored(".env.example")).toBe(false);
  });

  it("ignores only the top-level local/, not other paths named local", () => {
    expect(ignored("docs/local/notes.md")).toBe(false);
    expect(ignored("test/local.test.ts")).toBe(false);
  });
});

describe("repo scaffolding", () => {
  it.each(["CLAUDE.md", "BACKLOG.md", "README.md", ".gitleaks.toml", ".githooks/pre-commit", ".github/workflows/ci.yml"])(
    "%s exists",
    (p) => {
      expect(existsSync(join(root, p))).toBe(true);
    },
  );

  it("README has a STATUS section", () => {
    expect(read("README.md")).toMatch(/^## STATUS/m);
  });

  it("CI uses GitHub-hosted runners only", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).not.toMatch(/self-hosted/);
    for (const m of ci.matchAll(/runs-on:\s*(\S+)/g)) expect(m[1]).toMatch(/^ubuntu-/);
  });

  it("CI needs no secrets (the e2e job runs an unclaimed sandbox PMS)", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).not.toMatch(/secrets\./);
    expect(ci).not.toMatch(/PLEX_TOKEN/);
  });
});
