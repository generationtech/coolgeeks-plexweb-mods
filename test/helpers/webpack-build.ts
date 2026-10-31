// Builds a tiny multi-chunk app with the real webpack 5 compiler (production
// mode, minified) into a temp dir. Used to prove the loader and preflight
// work against genuine webpack output, not only hand-written fakes.
import webpack from "webpack";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface BuiltApp {
  outDir: string;
  /** Initial scripts in the order an HTML page would load them. */
  initial: string[];
  files: string[];
}

const SOURCES: Record<string, string> = {
  "src/index.js": `
    import { menu } from "./menu";
    import { createQueue } from "./shared/queue";
    globalThis.__result = menu();
    globalThis.__queue = createQueue("server://test-machine-identifier/x");
    globalThis.__lazy = () => import(/* webpackChunkName: "lazy" */ "./lazy").then((m) => m.settings());
  `,
  "src/menu.js": `
    export const menu = () => ["Play Next", "Add to Up Next"].join("|");
  `,
  "src/shared/queue.js": `
    export function createQueue(uri) {
      return { uri, playQueueID: 1, playQueueSelectedItemID: 2, method: "POST", path: "/playQueues" };
    }
  `,
  "src/lazy.js": `
    export const settings = () => "Lazy Settings";
  `,
};

let cached: Promise<BuiltApp> | null = null;

export function buildRealWebpackApp(): Promise<BuiltApp> {
  cached ??= new Promise((resolve, reject) => {
    const root = mkdtempSync(join(tmpdir(), "pwm-webpack-"));
    for (const [rel, src] of Object.entries(SOURCES)) {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), src);
    }
    const outDir = join(root, "dist", "js");
    webpack(
      {
        mode: "production",
        context: root,
        entry: { main: "./src/index.js" },
        target: "web",
        devtool: false,
        output: { path: outDir, filename: "[name].js", chunkFilename: "[name].chunk.js", publicPath: "js/", chunkLoadingGlobal: "webpackChunkfake_plex" },
        optimization: {
          runtimeChunk: "single",
          splitChunks: { chunks: "all", minSize: 0, cacheGroups: { shared: { test: /[\\/]shared[\\/]/, name: "shared", enforce: true } } },
        },
      },
      (err, stats) => {
        if (err) return reject(err);
        if (stats?.hasErrors()) return reject(new Error(stats.toString("errors-only")));
        resolve({ outDir, initial: ["runtime.js", "shared.js", "main.js"], files: readdirSync(outDir) });
      },
    );
  });
  return cached;
}
