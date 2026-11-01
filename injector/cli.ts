/**
 * plexweb-mods reapply CLI (bundled to dist/injector.cjs; run via injector/reapply.sh).
 *
 *   reapply.sh                 apply (preflight-gated), idempotent
 *   reapply.sh --dry-run       show what would change, change nothing
 *   reapply.sh --uninstall     remove the injection and the runtime file
 *   reapply.sh --status        show the current state
 *   reapply.sh --verify-served check over HTTP that PMS serves this build (no file access)
 *
 * Config (env, see .env.example): PLEX_INSTALL_TYPE (linux|docker|podman), PLEX_WEB_DIR,
 * PLEX_CONTAINER (alias: PLEX_DOCKER_CONTAINER), PLEX_URL (only for --verify).
 * Exit codes: 0 ok, 1 error, 2 usage, 3 preflight failed.
 */
import { dirname, join, resolve } from "node:path";
import { plugins } from "../patches/index";
import { detectChunkGlobalsInDir } from "../preflight/extract";
import { formatPreflight, runPreflight } from "../preflight/preflight";
import { reapply, type Mode } from "./reapply";
import { ContainerFs, INSTALL_TYPES, LocalFs, type InstallType } from "./target-fs";

const HELP = `usage: reapply.sh [--dry-run] [--uninstall | --status] [options]

options:
  --dry-run            print planned changes (with a diff) and change nothing
  --uninstall          remove the injected tag and runtime file (restores index.html)
  --status             show whether Plex Web is injected and with which version
  --snapshot [DIR]     copy the server's Plex Web (read-only) into bundle-snapshots/ for research
  --force              apply even if preflight reports anchor failures
  --skip-preflight     do not run the anchor preflight before applying
  --no-banner          never show the on-page failure banner (console only)
  --verify             after applying, fetch PLEX_URL/web/index.html and the runtime over HTTP
  --verify-served      only that HTTP check, touching no files (e.g. for a derived image); needs PLEX_URL
  --opt key=value      plugin option, e.g. --opt pfh-companion=off (repeatable)
  --install-type T     linux | docker | podman   (env PLEX_INSTALL_TYPE, default linux)
  --web-dir DIR        Plex Web dir with index.html (env PLEX_WEB_DIR; auto-discovered if unset)
  --container NAME     docker/podman container  (env PLEX_CONTAINER or PLEX_DOCKER_CONTAINER, default plex)
  --runtime PATH       built runtime            (default dist/plexweb-mods.js next to this tool)

Containers with a read-only root filesystem (podman/docker run --read-only)
cannot be changed in place: build a derived image instead (image/, README.md).
`;

function fail(msg: string): never {
  console.error(`reapply: ${msg}\n\n${HELP}`);
  process.exit(2);
}

async function main() {
  const args = process.argv.slice(2);
  let mode: Mode = "apply";
  let dryRun = false;
  let force = false;
  let skipPreflight = false;
  let banner: boolean | undefined;
  let verify = false;
  const opts: Record<string, string> = {};
  let installType = process.env.PLEX_INSTALL_TYPE || "linux";
  let webDir = process.env.PLEX_WEB_DIR || undefined;
  let container = process.env.PLEX_CONTAINER || process.env.PLEX_DOCKER_CONTAINER || "plex";
  let runtimePath = resolve(__dirname, "plexweb-mods.js");
  let snapshotDir: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const val = () => args[++i] ?? fail(`${a} needs a value`);
    if (a === "--dry-run") dryRun = true;
    else if (a === "--uninstall") mode = "uninstall";
    else if (a === "--status") mode = "status";
    else if (a === "--snapshot") {
      mode = "snapshot";
      if (args[i + 1] && !args[i + 1]!.startsWith("--")) snapshotDir = resolve(args[++i]!);
    }
    else if (a === "--force") force = true;
    else if (a === "--skip-preflight") skipPreflight = true;
    else if (a === "--no-banner") banner = false;
    else if (a === "--verify") verify = true;
    else if (a === "--verify-served") {
      mode = "verify";
      verify = true;
    }
    else if (a === "--opt") {
      const kv = val();
      const eq = kv.indexOf("=");
      if (eq < 1) fail(`--opt expects key=value, got "${kv}"`);
      opts[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (a === "--install-type") installType = val();
    else if (a === "--web-dir") webDir = val();
    else if (a === "--container") container = val();
    else if (a === "--runtime") runtimePath = resolve(val());
    else if (a === "-h" || a === "--help") {
      console.log(HELP);
      process.exit(0);
    } else fail(`unknown argument ${a}`);
  }
  if (!INSTALL_TYPES.includes(installType as InstallType)) fail(`PLEX_INSTALL_TYPE must be ${INSTALL_TYPES.join(", ")}; got "${installType}"`);
  if (verify && !process.env.PLEX_URL) fail("--verify needs PLEX_URL");

  if (mode === "snapshot" && !snapshotDir) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    snapshotDir = join(dirname(__dirname), "bundle-snapshots", `${installType}-${stamp}`);
  }
  try {
    const fs = installType === "linux" ? new LocalFs() : new ContainerFs(installType as "docker" | "podman", container);
    const result = await reapply({
      fs,
      mode,
      installType: installType as InstallType,
      ...(webDir ? { webDir } : {}),
      runtimePath,
      dryRun,
      force,
      skipPreflight,
      ...(banner !== undefined ? { banner } : {}),
      ...(Object.keys(opts).length ? { pluginOptions: opts } : {}),
      preflight: (dir) => runPreflight(dir, plugins),
      detectChunkGlobals: detectChunkGlobalsInDir,
      formatPreflight,
      ...(verify ? { verifyUrl: process.env.PLEX_URL! } : {}),
      ...(snapshotDir ? { snapshotDir } : {}),
      log: (line) => console.log(line),
    });
    process.exit(result.exitCode);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    console.error(`reapply: ${e.message}`);
    if (e.code === "EACCES" || e.code === "EPERM") {
      console.error('hint: the Plex Web dir is root-owned; run with: sudo env "PATH=$PATH" ./injector/reapply.sh');
    }
    process.exit(1);
  }
}

void main();
