/**
 * Usage: node dist/preflight.cjs --bundle-dir <dir> [--json] [--anchors]
 * Exit codes: 0 = all required anchors resolved, 1 = failures, 2 = usage error.
 */
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { plugins } from "../patches/index";
import { listAnchors } from "../patches/play-from-here/plex-anchors";
import { formatPreflight, runPreflight } from "./preflight";

function usage(msg?: string): never {
  if (msg) console.error(`preflight: ${msg}`);
  console.error("usage: preflight --bundle-dir <dir> [--json] [--anchors]");
  process.exit(2);
}

const args = process.argv.slice(2);
let dir: string | undefined;
let json = false;
let anchors = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === "--bundle-dir") dir = args[++i];
  else if (a.startsWith("--bundle-dir=")) dir = a.slice("--bundle-dir=".length);
  else if (a === "--json") json = true;
  else if (a === "--anchors") anchors = true;
  else if (a === "-h" || a === "--help") usage();
  else usage(`unknown argument ${a}`);
}

if (anchors) {
  for (const a of listAnchors()) console.log(`${a.status.padEnd(10)} ${a.path.padEnd(36)} ${a.value}\n${" ".repeat(11)}${a.source}`);
  if (!dir) process.exit(0);
}
if (!dir) usage("--bundle-dir is required");
const abs = resolve(dir);
if (!existsSync(abs) || !statSync(abs).isDirectory()) usage(`not a directory: ${abs}`);

const result = runPreflight(abs, plugins);
console.log(json ? JSON.stringify(result, null, 2) : formatPreflight(result));
process.exit(result.ok ? 0 : 1);
