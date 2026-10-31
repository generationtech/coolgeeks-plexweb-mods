// Builds every output into dist/:
//   dist/plexweb-mods.js  browser runtime (IIFE) injected into Plex Web
//   dist/injector.cjs     reapply tool (Node)
//   dist/preflight.cjs    anchor preflight (Node)
import { build } from "esbuild";
import { readFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
let rev = "dev";
try {
  rev = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
} catch {
  /* not a git checkout */
}
const version = `${pkg.version}+${rev}`;
mkdirSync("dist", { recursive: true });

const common = { bundle: true, legalComments: "none", logLevel: "info", define: { __PLEXWEB_MODS_VERSION__: JSON.stringify(version) } };

await build({
  ...common,
  entryPoints: ["runtime/entry.ts"],
  outfile: "dist/plexweb-mods.js",
  platform: "browser",
  format: "iife",
  target: ["es2020"],
  minify: false,
  banner: { js: `/* plexweb-mods ${version} | MIT | https://github.com/generationtech/coolgeeks-plexweb-mods */` },
});

const node = { ...common, platform: "node", format: "cjs", target: ["node22"] };
const entries = [
  ["injector/cli.ts", "dist/injector.cjs"],
  ["preflight/cli.ts", "dist/preflight.cjs"],
];
for (const [entry, outfile] of entries) {
  try {
    readFileSync(entry);
  } catch {
    continue; // not written yet
  }
  await build({ ...node, entryPoints: [entry], outfile, banner: { js: "#!/usr/bin/env node" } });
}
console.log(`built ${version}`);
