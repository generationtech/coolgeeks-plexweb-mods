/**
 * Filesystem access to where Plex Web lives: directly on this machine
 * (Linux package install) or inside a Docker container (docker exec / cp).
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export interface TargetFs {
  describe(): string;
  exists(path: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  /** Copies a local file to `path` on the target. */
  copyIn(localPath: string, path: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** Absolute paths of index.html files below `root` that belong to Plex Web. */
  findPlexWebIndex(root: string): Promise<string[]>;
  /** A local directory with the target dir's contents (read-only use). */
  localView(path: string): Promise<string>;
}

export const PLEX_WEB_INDEX_SUFFIX = "WebClient.bundle/Contents/Resources/index.html";

/** PMS install roots to search when PLEX_WEB_DIR is not set (unverified; see BACKLOG B1). */
export const DEFAULT_SEARCH_ROOTS: Record<"linux" | "docker", string[]> = {
  linux: ["/usr/lib/plexmediaserver", "/usr/lib64/plexmediaserver", "/opt/plexmediaserver"],
  docker: ["/usr/lib/plexmediaserver"],
};

export class LocalFs implements TargetFs {
  describe() {
    return "local filesystem";
  }
  async exists(p: string) {
    return fs.access(p).then(
      () => true,
      () => false,
    );
  }
  readText(p: string) {
    return fs.readFile(p, "utf8");
  }
  async writeText(p: string, content: string) {
    // write-then-rename so a crash never leaves a half-written index.html
    const tmp = `${p}.plexweb-mods.tmp`;
    await fs.writeFile(tmp, content);
    const st = await fs.stat(p).catch(() => null);
    if (st) await fs.chmod(tmp, st.mode & 0o7777);
    await fs.rename(tmp, p);
  }
  async copyIn(local: string, p: string) {
    await fs.copyFile(local, p);
    await fs.chmod(p, 0o644);
  }
  async remove(p: string) {
    await fs.rm(p, { force: true });
  }
  async findPlexWebIndex(root: string) {
    const out: string[] = [];
    const walk = async (d: string, depth: number) => {
      if (depth > 8) return;
      const entries = await fs.readdir(d, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        const p = join(d, e.name);
        if (e.isDirectory()) await walk(p, depth + 1);
        else if (p.endsWith(`/${PLEX_WEB_INDEX_SUFFIX}`)) out.push(p);
      }
    };
    await walk(root, 0);
    return out;
  }
  async localView(p: string) {
    return p;
  }
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type Exec = (cmd: string, args: string[]) => Promise<ExecResult>;

export const execProcess: Exec = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as any).code === "number" ? (err as any).code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) || (err && typeof (err as any).code !== "number" ? String(err.message) : "") });
    });
  });

export class DockerFs implements TargetFs {
  constructor(
    private readonly container: string,
    private readonly exec: Exec = execProcess,
  ) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(container)) throw new Error(`invalid container name "${container}"`);
  }
  describe() {
    return `docker container "${this.container}"`;
  }
  private async run(args: string[], what: string): Promise<string> {
    const r = await this.exec("docker", args);
    if (r.code !== 0) throw new Error(`${what} failed (docker ${args.join(" ")}): ${r.stderr.trim() || `exit ${r.code}`}`);
    return r.stdout;
  }
  async exists(p: string) {
    return (await this.exec("docker", ["exec", this.container, "test", "-e", p])).code === 0;
  }
  readText(p: string) {
    return this.run(["exec", this.container, "cat", p], `reading ${p}`);
  }
  async writeText(p: string, content: string) {
    const dir = mkdtempSync(join(tmpdir(), "plexweb-mods-"));
    const local = join(dir, basename(p));
    await fs.writeFile(local, content, { mode: 0o644 });
    try {
      await this.copyIn(local, p);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
  async copyIn(local: string, p: string) {
    await this.run(["cp", local, `${this.container}:${p}`], `copying to ${p}`);
  }
  async remove(p: string) {
    await this.run(["exec", this.container, "rm", "-f", p], `removing ${p}`);
  }
  async findPlexWebIndex(root: string) {
    const r = await this.exec("docker", ["exec", this.container, "find", root, "-maxdepth", "9", "-path", `*/${PLEX_WEB_INDEX_SUFFIX}`]);
    return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  }
  async localView(p: string) {
    const dir = mkdtempSync(join(tmpdir(), "plexweb-mods-view-"));
    await this.run(["cp", `${this.container}:${p}`, dir], `copying ${p} out of the container`);
    return join(dir, basename(p));
  }
}
