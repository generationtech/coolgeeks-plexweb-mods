// The e2e suite must compile and skip cleanly when no server is configured.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");

describe("playwright e2e skeleton", () => {
  it("lists the spec and skips it without PLEX_URL", () => {
    const env = { ...process.env };
    delete env.PLEX_URL;
    const r = spawnSync(process.execPath, [join(root, "node_modules/@playwright/test/cli.js"), "test", "--reporter=list"], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 90_000,
    });
    const out = r.stdout + r.stderr;
    expect(r.status, out).toBe(0);
    expect(out).toMatch(/1 skipped/);
    expect(out).not.toMatch(/passed|failed/);
  }, 120_000);
});
