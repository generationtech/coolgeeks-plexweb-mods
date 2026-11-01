// Verifies the custom rules in .gitleaks.toml fire on leaks and stay quiet on
// placeholders. Samples are assembled at runtime so this file itself never
// matches a rule. Skipped when the gitleaks binary is not on PATH.
import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const hasGitleaks = spawnSync("gitleaks", ["version"], { stdio: "ignore" }).status === 0;

interface Finding {
  RuleID: string;
  File: string;
}

function scan(files: Record<string, string>): Finding[] {
  const dir = mkdtempSync(join(tmpdir(), "gitleaks-rules-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  const out = execFileSync(
    "gitleaks",
    ["dir", dir, "-c", join(root, ".gitleaks.toml"), "--no-banner", "--report-format", "json", "--report-path", "-", "--exit-code", "0", "--log-level", "error"],
    { encoding: "utf8" },
  );
  return (JSON.parse(out) as Finding[]).map((f) => ({ ...f, File: f.File.split("/").pop()! }));
}

// Fake values, built so no literal in this file looks like a secret.
const tok = ["abcD", "EF12", "3ghi", "JKL4", "56mn"].join("");
const hex40 = "0123456789abcdef".repeat(3).slice(0, 40);
const hex32 = hex40.slice(0, 32);
const uuid = [hex32.slice(0, 8), hex32.slice(8, 12), hex32.slice(12, 16), hex32.slice(16, 20), hex32.slice(20)].join("-");
const lan = (a: number, b: number, c: number, d: number) => [a, b, c, d].join(".");

describe.skipIf(!hasGitleaks)("gitleaks custom rules", () => {
  it("flags Plex tokens, identifiers, UUIDs, plex.direct names and LAN IPs", () => {
    const findings = scan({
      "token-env.txt": `PLEX_TOKEN=${tok}\n`,
      "token-query.txt": `GET /library/sections?X-Plex-${"Token"}=${tok}&a=1\n`,
      "prefs.xml": `<Preferences PlexOnline${"Token"}="${tok}" ProcessedMachine${"Identifier"}="${hex40}"/>\n`,
      "server-uri.txt": `uri=server${"://"}${hex40}/com.plexapp.plugins.library\n`,
      "library-uri.txt": `uri=library${"://"}${uuid}/directory/x\n`,
      "direct.txt": `https://${["192", "168", "1", "5"].join("-")}.${hex32}.plex${".direct"}:32400\n`,
      "ip.txt": `host ${lan(192, 168, 7, 20)} and ${lan(10, 4, 5, 6)} and ${lan(172, 20, 0, 5)}\n`,
    });
    const byFile = (f: string) => findings.filter((x) => x.File === f).map((x) => x.RuleID);
    expect(byFile("token-env.txt")).toContain("plex-token");
    expect(byFile("token-query.txt")).toContain("plex-token");
    expect(byFile("prefs.xml")).toEqual(expect.arrayContaining(["plex-token", "plex-identifier"]));
    expect(byFile("server-uri.txt")).toContain("plex-identifier");
    expect(byFile("library-uri.txt")).toContain("plex-section-uuid");
    expect(byFile("direct.txt")).toContain("plex-direct-hostname");
    expect(byFile("ip.txt").filter((r) => r === "private-ipv4")).toHaveLength(3);
  });

  it("stays quiet on placeholders, CIDR ranges and public example values", () => {
    const findings = scan({
      "env.example": readFileSync(join(root, ".env.example"), "utf8"),
      "cidr.txt": `allow ${lan(10, 0, 0, 0)}/8 and ${lan(192, 168, 0, 0)}/16\n`,
      "placeholders.ts": `const uri = "server://test-machine-identifier/com.plexapp.plugins.library";\nheaders["X-Plex-Token"] = "test-token";\n`,
      "versions.txt": "release 1.2.3.4 and 8.30.1\n",
    });
    expect(findings).toEqual([]);
  });
});

describe.skipIf(!hasGitleaks)("gitleaks local-dir rule", () => {
  it("flags staged files under the top-level local/ only, as the pre-commit scan sees them", () => {
    const repo = mkdtempSync(join(tmpdir(), "gitleaks-local-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
    git("init", "-q");
    for (const p of ["local/tools/peek.ts", "docs/local/notes.md"]) {
      mkdirSync(join(repo, p, ".."), { recursive: true });
      writeFileSync(join(repo, p), "harmless\n");
    }
    git("add", "-f", ".");
    const out = execFileSync(
      "gitleaks",
      ["git", "--pre-commit", "--staged", "-c", join(root, ".gitleaks.toml"), "--no-banner", "--report-format", "json", "--report-path", "-", "--exit-code", "0", "--log-level", "error", "."],
      { cwd: repo, encoding: "utf8" },
    );
    const findings = (JSON.parse(out) as Finding[]).map((f) => `${f.RuleID} ${f.File}`);
    expect(findings).toEqual(["local-dir local/tools/peek.ts"]);
  });
});
