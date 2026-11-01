// The derived-image build context (image/): the patch stage script run
// against fake Plex install trees, the build wrapper against a fake engine,
// and the Containerfile's shape. No container engine is needed.
import { beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { bundleFixture } from "./helpers/realm";

const root = join(import.meta.dirname, "..");
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const WEB_REL = "usr/lib/plexmediaserver/Resources/Plug-ins-test/WebClient.bundle/Contents/Resources";
const sha256 = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(relative(dir, p));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}

let modsDir: string;
beforeAll(async () => {
  modsDir = tmp("image-mods-");
  await build({ entryPoints: [join(root, "injector/cli.ts")], bundle: true, platform: "node", format: "cjs", outfile: join(modsDir, "injector.cjs"), logLevel: "silent" });
  writeFileSync(join(modsDir, "plexweb-mods.js"), "/* image runtime */");
});

describe("image/apply-in-build.sh (the patch stage)", () => {
  function plexRoot(fixture: string | null, copies = 1): string {
    const r = tmp("image-root-");
    for (let i = 0; i < copies; i++) {
      const web = join(r, WEB_REL.replace("Plug-ins-test", `Plug-ins-test${i || ""}`));
      mkdirSync(web, { recursive: true });
      if (fixture) cpSync(bundleFixture(fixture), web, { recursive: true });
    }
    mkdirSync(join(r, "usr/lib/plexmediaserver"), { recursive: true });
    return r;
  }
  const run = (plex: string, out: string, args: string[] = []) =>
    spawnSync("sh", [join(root, "image/apply-in-build.sh"), ...args], {
      encoding: "utf8",
      env: { PATH: process.env.PATH!, PLEX_ROOT: plex, MODS_DIR: modsDir, OUT: out },
    });

  it("applies to a Plex Web that passes preflight and lays out exactly index.html and the runtime", () => {
    const plex = plexRoot("wp5-plex-shape");
    chmodSync(join(plex, "usr/lib/plexmediaserver/Resources"), 0o750); // parents keep the image's attributes
    chmodSync(join(plex, WEB_REL, "index.html"), 0o644); // as the PMS .deb ships it; the injector keeps the mode
    const out = join(tmp("image-out-"), "out");
    const r = run(plex, out, ["--opt", "pfh-companion=off", "--no-banner"]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/RESULT: all required anchors resolved/);
    expect(filesUnder(out)).toEqual([`${WEB_REL}/index.html`, `${WEB_REL}/plexweb-mods.js`]);
    const html = readFileSync(join(out, WEB_REL, "index.html"), "utf8");
    expect(html).toMatch(/<script src="plexweb-mods\.js\?v=[0-9a-f]{12}"[^>]*data-banner="off"[^>]*data-opt-pfh-companion="off"/);
    expect(readFileSync(join(out, WEB_REL, "plexweb-mods.js"), "utf8")).toBe("/* image runtime */");
    expect(statSync(join(out, WEB_REL, "index.html")).mode & 0o777).toBe(0o644);
    expect(statSync(join(out, WEB_REL, "plexweb-mods.js")).mode & 0o777).toBe(0o644);
    expect(statSync(join(out, "usr/lib/plexmediaserver/Resources")).mode & 0o777).toBe(0o750);
    expect(r.stdout).toContain(`${sha256(join(out, WEB_REL, "index.html"))}  ./${WEB_REL}/index.html`);
  });

  it("fails with the injector's exit 3 and writes nothing when preflight fails", () => {
    const out = join(tmp("image-out-"), "out");
    const r = run(plexRoot("wp5"), out);
    expect(r.status).toBe(3);
    expect(r.stdout).toMatch(/preflight failed; not applying/);
    expect(filesUnder(out)).toEqual([]);
  });

  it.each([
    ["no", null, 1, 0],
    ["two", "wp5-plex-shape", 2, 2],
  ])("refuses when it finds %s Plex Web copies", (_, fixture, copies, n) => {
    const out = join(tmp("image-out-"), "out");
    const r = run(plexRoot(fixture as string | null, copies as number), out);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`expected exactly one Plex Web index.html under`);
    expect(r.stderr).toContain(`found ${n}`);
    expect(filesUnder(out)).toEqual([]);
  });
});

describe("image/build-image.sh (the build wrapper)", () => {
  const NODE = `docker.io/library/node:22-bookworm-slim@sha256:${"ab12".repeat(16)}`;

  const DIGEST = `sha256:${"d1".repeat(32)}`;
  const ID = "e2".repeat(32);
  /**
   * The fake engine answers `image inspect` like podman: a manifest digest for
   * {{.Digest}}, a bare image ID for {{.Id}}; `build` succeeds.
   */
  const PODMAN_LIKE = `case "$1 $3 $4" in
  "image --format {{.Digest}}") echo "${DIGEST}" ;;
  "image --format {{.Id}}") echo "${ID}" ;;
esac
case "$1" in image | build) exit 0 ;; esac; exit 9`;
  /** Like docker for a locally built image: no digest at all, ID with its prefix. */
  const DOCKER_LIKE = `case "$1 $3 $4" in
  "image --format {{.Digest}}" | "image --format {{index .RepoDigests 0}}") exit 1 ;;
  "image --format {{.Id}}") echo "sha256:${ID}" ;;
esac
case "$1" in image | build) exit 0 ;; esac; exit 9`;

  /** A build context like dist/image/, and a fake engine that logs its calls. */
  function setup(engineScript = PODMAN_LIKE) {
    const ctx = tmp("image-ctx-");
    for (const f of ["Containerfile", "apply-in-build.sh", "build-image.sh", "README.md"]) copyFileSync(join(root, "image", f), join(ctx, f));
    writeFileSync(join(ctx, "injector.cjs"), "/* injector */");
    writeFileSync(join(ctx, "plexweb-mods.js"), "/* runtime */");
    writeFileSync(join(ctx, "VERSION"), "9.9.9+test runtime=0123456789ab\n");
    writeFileSync(join(ctx, "REVISION"), `${"c3".repeat(20)}\n`);
    writeFileSync(join(ctx, "SHA256SUMS"), readdirSync(ctx).sort().map((f) => `${sha256(join(ctx, f))}  ${f}\n`).join(""));
    const bin = tmp("image-bin-");
    const log = join(bin, "calls.log");
    for (const engine of ["podman", "docker"]) {
      writeFileSync(join(bin, engine), `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > "${log}.$$"\necho "${engine}" >> "${log}"; cat "${log}.$$" >> "${log}"; echo -- >> "${log}"\n${engineScript}\n`, { mode: 0o755 });
    }
    const run = (args: string[]) =>
      spawnSync("sh", [join(ctx, "build-image.sh"), ...args], { encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH!}` } });
    const calls = () => (existsSync(log) ? readFileSync(log, "utf8").split("--\n").filter(Boolean).map((c) => c.trim().split("\n")) : []);
    return { ctx, run, calls };
  }
  const base = ["--plex-image", "localhost/plex:1.2.3.4-abc", "--node-image", NODE, "--tag", "localhost/plex-mods:1.2.3.4-abc"];

  it("checks the context and the Plex image, then builds without network, passing every input as a build arg", () => {
    const { run, calls } = setup();
    const r = run([...base, "--opt", "pfh-companion=off", "--opt", "pfh-drop-params=a,b", "--no-banner"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/build-image: built localhost\/plex-mods:1\.2\.3\.4-abc/);
    const all = calls();
    expect(all[0]).toEqual(["podman", "image", "inspect", "localhost/plex:1.2.3.4-abc"]);
    expect(all.at(-1)).toEqual([
      "podman", "build", "--network", "none",
      "--build-arg", "PLEX_IMAGE=localhost/plex:1.2.3.4-abc",
      "--build-arg", `NODE_IMAGE=${NODE}`,
      "--build-arg", "MODS_ARGS=--opt pfh-companion=off --opt pfh-drop-params=a,b --no-banner",
      "--build-arg", "MODS_VERSION=9.9.9+test runtime=0123456789ab",
      "--build-arg", `MODS_REVISION=${"c3".repeat(20)}`,
      "--build-arg", `PLEX_IMAGE_DIGEST=${DIGEST}`,
      "--build-arg", `PLEX_IMAGE_ID=sha256:${ID}`,
      "-f", "Containerfile", "-t", "localhost/plex-mods:1.2.3.4-abc", ".",
    ]);
    expect(r.stdout).toContain(`(digest ${DIGEST}, id sha256:${ID})`);
  });

  it("uses docker when asked; without a manifest digest the label falls back to the image ID", () => {
    const { run, calls } = setup(DOCKER_LIKE);
    const r = run([...base, "--engine", "docker"]);
    expect(r.status, r.stderr).toBe(0);
    expect(new Set(calls().map((c) => c[0]))).toEqual(new Set(["docker"]));
    expect(r.stderr).toMatch(/reports no manifest digest .* records its image ID only/);
    const build = calls().at(-1)!;
    expect(build).toContain("PLEX_IMAGE_DIGEST=unknown");
    expect(build).toContain(`PLEX_IMAGE_ID=sha256:${ID}`);
  });

  it.each([
    ["an unpinned Node image", ["--plex-image", "p:1", "--node-image", "node:22", "--tag", "m:1"], /pinned by digest/],
    ["a tag equal to the Plex image", ["--plex-image", "p:1", "--node-image", NODE, "--tag", "p:1"], /must differ from --plex-image/],
    ["a missing tag", ["--plex-image", "p:1", "--node-image", NODE], /--tag is required/],
    ["an option value with shell syntax", [...base, "--opt", "pfh-x=$(id)"], /--opt expects key=value/],
    ["an unknown engine", [...base, "--engine", "buildah"], /--engine must be podman or docker/],
    ["an unknown flag", [...base, "--force"], /unknown argument: --force/],
  ])("rejects %s (exit 2) and runs nothing", (_, args, msg) => {
    const { run, calls } = setup();
    const r = run(args as string[]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(msg as RegExp);
    expect(calls()).toEqual([]);
  });

  it("refuses a build context that does not match SHA256SUMS", () => {
    const { ctx, run, calls } = setup();
    writeFileSync(join(ctx, "plexweb-mods.js"), "/* changed after packing */");
    const r = run(base);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/does not match its SHA256SUMS/);
    expect(calls()).toEqual([]);
  });

  it("stops when the Plex image ID cannot be read", () => {
    const { run, calls } = setup('case "$1 $3 $4" in "image --format {{.Id}}") exit 1 ;; esac; case "$1" in image) exit 0 ;; esac; exit 9');
    const r = run(base);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/could not read the image ID/);
    expect(calls().some((c) => c[1] === "build")).toBe(false);
  });

  it("stops when the Plex image is not there", () => {
    const { run, calls } = setup('case "$1" in image) exit 1 ;; esac; exit 0');
    const r = run(base);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Plex image localhost\/plex:1\.2\.3\.4-abc not found/);
    expect(calls()).toHaveLength(1);
  });

  it("reports a failed build (e.g. preflight exit 3 in the patch stage) with what to do", () => {
    const { run } = setup(PODMAN_LIKE.replace("image | build) exit 0", "image) exit 0 ;; build) exit 3"));
    const r = run(base);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/build failed \(exit 3\)\. If the log above says 'preflight failed'.*keep running your current image/);
  });
});

describe("image/Containerfile and the dist/image assembly", () => {
  const cf = readFileSync(join(root, "image/Containerfile"), "utf8");
  const lines = cf.split("\n").filter((l) => l.trim() && !l.startsWith("#"));

  it("labels the result with the mods revision and the base image's name, digest and ID (OCI keys)", () => {
    const label = lines.filter((l) => /^(LABEL|\s+[a-z])/.test(l)).join("\n");
    for (const kv of [
      'org.opencontainers.image.revision="${MODS_REVISION}"',
      'org.opencontainers.image.base.name="${PLEX_IMAGE}"',
      'org.opencontainers.image.base.digest="${PLEX_IMAGE_DIGEST}"',
      'io.github.generationtech.plexweb-mods.base.id="${PLEX_IMAGE_ID}"',
    ])
      expect(label).toContain(kv);
  });

  it("has no default for the Plex or Node image (both must be passed)", () => {
    expect(lines).toContain("ARG PLEX_IMAGE");
    expect(lines).toContain("ARG NODE_IMAGE");
  });

  it("adds only the patch stage's /out tree to the Plex image: no RUN, no other COPY", () => {
    const final = lines.slice(lines.lastIndexOf("FROM plex"));
    expect(final.filter((l) => /^(RUN|COPY|ADD|USER|ENTRYPOINT|CMD|ENV|WORKDIR|VOLUME|EXPOSE)\b/.test(l))).toEqual(["COPY --from=patch /out/ /"]);
  });

  it("copies into the patch stage exactly the files that npm run build packs", () => {
    const copied = /^COPY (injector\.cjs plexweb-mods\.js apply-in-build\.sh) \/plexweb-mods\/$/m.exec(cf)![1]!.split(" ");
    const buildScript = readFileSync(join(root, "scripts/build.mjs"), "utf8");
    for (const f of copied) expect(buildScript).toContain(`"${f}"`);
  });

  it("ships executable shell scripts that parse", () => {
    for (const f of ["apply-in-build.sh", "build-image.sh"]) expect(spawnSync("sh", ["-n", join(root, "image", f)]).status).toBe(0);
  });
});
