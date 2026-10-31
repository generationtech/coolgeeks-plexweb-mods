/**
 * "Play from here": on any item in a sorted library view, start playback at
 * that item and continue through the list in the visible sort order.
 *
 *   network observer  -> which listing (section, sort, filters) is on screen
 *   DOM menu entry    -> which item the user picked
 *   POST /playQueues  -> uri = sorted section listing, key = that item
 *   native player     -> plays the queue (bundle hook; companion fallback)
 *
 * Plex-coupled values: ./plex-anchors.ts. Plex-coupled interfaces: ./bindings.ts.
 */
import type { PatchDef, PluginApi, PluginDef } from "../../runtime/types";
import type { NativePlayer } from "./bindings";
import { createDefaultBindings, parseRoute } from "./default-bindings";
import { createDomMenuIntegration } from "./dom-menu";
import { runPlayFromHere, type FlowResult } from "./flow";
import { installNetworkObserver, ListingTracker } from "./network-observer";
import type { ItemRef } from "./playqueue";
import { PLEX_ANCHORS } from "./plex-anchors";

export const PLUGIN_NAME = "play-from-here";

export interface PlayFromHerePlugin extends PluginDef {
  patches: PatchDef[];
  /** Set by a bundle patch/capture once Plex Web's player entry point is known. */
  nativePlayer: NativePlayer | null;
  registerNativePlayer(player: NativePlayer): void;
  /** Exposed for e2e tests and the DevTools console. */
  play(item: ItemRef): Promise<FlowResult | null>;
  tracker: ListingTracker | null;
  lastResult: FlowResult | null;
  lastError: string | null;
  diagnostics: {
    contextMenuModules: string[];
    nativePlayerCandidates: Array<{ moduleId: string; exportKeys: string[] }>;
  };
}

function exportKeys(exports: unknown): string[] {
  if (!exports || (typeof exports !== "object" && typeof exports !== "function")) return [];
  try {
    return Object.keys(exports as object).slice(0, 50);
  } catch {
    return [];
  }
}

/** Patch definitions. Anchors come from plex-anchors.ts (unverified candidates for now). */
export function createPatches(plugin: Pick<PlayFromHerePlugin, "diagnostics">): PatchDef[] {
  const { bundle } = PLEX_ANCHORS;
  return [
    {
      id: `${PLUGIN_NAME}/context-menu-module`,
      find: [...bundle.contextMenuModule.value],
      optional: true,
      lazy: true,
      all: true,
      note: `${bundle.contextMenuModule.status}: diagnostics only; the menu entry itself is added by the DOM integration`,
      onExports: (_exports, moduleId) => {
        plugin.diagnostics.contextMenuModules.push(moduleId);
      },
    },
    {
      id: `${PLUGIN_NAME}/native-player`,
      find: [...bundle.nativePlayerModule.value],
      lazy: true,
      all: true,
      note:
        `${bundle.nativePlayerModule.status}: candidate anchors; no adapter yet, so every located module ` +
        `reports EXPORTS_UNRECOGNIZED until the real entry point is identified (BACKLOG)`,
      onExports: (exports, moduleId) => {
        plugin.diagnostics.nativePlayerCandidates.push({ moduleId, exportKeys: exportKeys(exports) });
        // Adapter goes here once the entry point is known: build a NativePlayer
        // from these exports, call registerNativePlayer(), and return true.
        return false;
      },
    },
  ];
}

const plugin: PlayFromHerePlugin = {
  name: PLUGIN_NAME,
  description: "Start playback at an item of a sorted library view and continue in the visible order.",
  patches: [],
  nativePlayer: null,
  tracker: null,
  lastResult: null,
  lastError: null,
  diagnostics: { contextMenuModules: [], nativePlayerCandidates: [] },

  registerNativePlayer(player: NativePlayer) {
    plugin.nativePlayer = player;
  },

  async play(_item: ItemRef): Promise<FlowResult | null> {
    throw new Error("play-from-here is not started");
  },

  init(api: PluginApi) {
    const win = globalThis as unknown as Window & typeof globalThis;
    const tracker = new ListingTracker(() => win.location.href);
    plugin.tracker = tracker;
    installNetworkObserver(win, (req) => tracker.observe(req));
    api.log.debug("play-from-here: network observer installed");
  },

  start(api: PluginApi) {
    const win = globalThis as unknown as Window & typeof globalThis;
    const tracker = plugin.tracker ?? new ListingTracker(() => win.location.href);
    const opt = api.config.options;
    let commandId = 0;
    const bindings = createDefaultBindings({
      location: win.location,
      tracker,
      fetch: (url, init) => win.fetch(url, init),
      playback: {
        nativePlayer: () => plugin.nativePlayer,
        companionEnabled: opt["pfh-companion"] !== "off",
        fetch: (url, init) => win.fetch(url, init),
        nextCommandId: () => ++commandId,
      },
    });
    const scheme = opt["pfh-scheme"] === "library" ? "library" : "server";
    const dropParams = (opt["pfh-drop-params"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);

    plugin.play = async (item: ItemRef) => {
      try {
        const result = await runPlayFromHere({ bindings, fetch: (u, i) => win.fetch(u, i), requestOptions: { scheme, dropParams } }, item);
        plugin.lastResult = result;
        plugin.lastError = null;
        api.log.info(`play-from-here: queue ${result.queue.id} started via ${result.playback}`);
        return result;
      } catch (err) {
        plugin.lastError = (err as Error).message;
        api.log.error(err);
        api.notify(`Play from here failed: ${(err as Error).message}`, "error");
        return null;
      }
    };

    const { dom } = PLEX_ANCHORS;
    createDomMenuIntegration({
      doc: win.document,
      menuSelector: dom.menuSelector.value,
      menuItemSelector: dom.menuItemSelector.value,
      anchorLabels: dom.menuAnchorLabels.value,
      itemLinkSelector: dom.itemLinkSelector.value,
      itemKeyPattern: dom.itemKeyPattern.value,
    }).install({
      isAvailable: () => (opt["pfh-route-check"] === "off" || parseRoute(win.location.hash).isListing) && !!bindings.currentListing(),
      onSelect: (item) => void plugin.play(item),
    });
  },
};
plugin.patches = createPatches(plugin);

export default plugin;
