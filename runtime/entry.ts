/** Browser entry point bundled into dist/plexweb-mods.js. */
import { plugins } from "../patches/index";
import { bootstrap } from "./bootstrap";
import { parseConfig } from "./config";

declare const __PLEXWEB_MODS_VERSION__: string;

(() => {
  const script = (typeof document !== "undefined" ? document.currentScript : null) as HTMLScriptElement | null;
  let debug: string | null = null;
  try {
    debug = globalThis.localStorage?.getItem("plexweb-mods:debug") ?? null;
  } catch {
    /* storage may be blocked */
  }
  const config = parseConfig({ ...(script?.dataset ?? {}) }, debug);
  try {
    bootstrap({ target: globalThis, plugins, config, version: __PLEXWEB_MODS_VERSION__ });
  } catch (err) {
    // Never take Plex Web down with us.
    console.error("[plexweb-mods] failed to start", err);
  }
})();
