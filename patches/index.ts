/** Registry of all mods shipped in dist/plexweb-mods.js (and checked by preflight). */
import type { PluginDef } from "../runtime/types";
import playFromHere from "./play-from-here/index";

export const plugins: readonly PluginDef[] = [playFromHere];
