// Points git at the committed hooks in .githooks/ (run by `npm install`).
// No-op outside a git checkout (e.g. when installed as a tarball).
import { execFileSync } from "node:child_process";

try {
  execFileSync("git", ["rev-parse", "--git-dir"], { stdio: "ignore" });
} catch {
  process.exit(0);
}
execFileSync("git", ["config", "core.hooksPath", ".githooks"], { stdio: "inherit" });
console.log("git hooks: core.hooksPath -> .githooks");
