// Builds every output into dist/:
//   dist/plexweb-mods.js  browser runtime (IIFE) injected into Plex Web
//   dist/injector.cjs     reapply tool (Node)
//   dist/preflight.cjs    anchor preflight (Node)
//   dist/fetch-plex-web.cjs  public Plex Web snapshot tool (Node)
//   dist/image/           build context for a derived container image (image/)
import { build } from "esbuild";
import { chmodSync, copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
let rev = "dev";
let revision = "unknown"; // full commit SHA for the image label, "-dirty" if tracked files changed
try {
  rev = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim()) revision += "-dirty";
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
  ["tools/fetch-plex-web.ts", "dist/fetch-plex-web.cjs"],
];
for (const [entry, outfile] of entries) {
  try {
    readFileSync(entry);
  } catch {
    continue; // not written yet
  }
  await build({ ...node, entryPoints: [entry], outfile, banner: { js: "#!/usr/bin/env node" } });
}

// dist/image/: build context for a derived container image (image/README.md).
// VERSION carries the runtime's content hash, the same ?v= value the injector
// writes into index.html; REVISION the full commit SHA (an image label);
// SHA256SUMS is checked by build-image.sh. Modes are fixed (dir and scripts
// 0750, files 0640) so a copy to the build host does not depend on umask.
const IMAGE_FILES = ["Containerfile", "apply-in-build.sh", "build-image.sh", "README.md"];
const imageDir = "dist/image";
rmSync(imageDir, { recursive: true, force: true });
mkdirSync(imageDir, { recursive: true });
for (const f of IMAGE_FILES) copyFileSync(`image/${f}`, `${imageDir}/${f}`);
for (const f of ["injector.cjs", "plexweb-mods.js"]) copyFileSync(`dist/${f}`, `${imageDir}/${f}`);
const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
writeFileSync(`${imageDir}/VERSION`, `${version} runtime=${sha256(`${imageDir}/plexweb-mods.js`).slice(0, 12)}\n`);
writeFileSync(`${imageDir}/REVISION`, `${revision}\n`);
const sums = readdirSync(imageDir)
  .sort()
  .map((f) => `${sha256(`${imageDir}/${f}`)}  ${f}\n`)
  .join("");
writeFileSync(`${imageDir}/SHA256SUMS`, sums);
for (const f of readdirSync(imageDir)) chmodSync(`${imageDir}/${f}`, f.endsWith(".sh") ? 0o750 : 0o640);
chmodSync(imageDir, 0o750);
console.log(`built ${version} (and ${imageDir}/)`);
