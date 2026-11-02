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
import { createFallbackPlayer, createNativePlayer, findHandlerMap, type NativePlayerState } from "./native-player";
import { parseCompanionEnabled, parsePlayerPreference } from "./playback";
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
  };
  /** State filled by the native-player patch. */
  native: NativePlayerState;
  /** State filled by the native-player-fallback patch (shares the appModel getter). */
  nativeFallback: NativePlayerState;
  /** Called from the patched module (via $self) with its appModel lookup. */
  registerAppModelGetter(getter: () => unknown): void;
  /** Which playback path a click would use right now (for the console and e2e). */
  activePath(): { path: string | null; reason?: string };
}

/**
 * Patch definitions (anchors from plex-anchors.ts):
 *  - native-player: the module defining the "start existing play queue"
 *    action. One replacement exposes the module's own appModel lookup to
 *    $self (minified names are captured from the code, never hard-coded);
 *    an export capture finds the action-handler map by its action-type key.
 *  - native-player-fallback: same idea for the "queue playback" action
 *    (pointed at our queue), used when the first is gone. Both form the group "play-from-here/player":
 *    either one is enough, and reports name the active one.
 *  - context-menu-module: optional diagnostics (the menu entry is added by
 *    the DOM integration).
 */
export const PLAYER_GROUP = `${PLUGIN_NAME}/player`;

export function createPatches(plugin: Pick<PlayFromHerePlugin, "diagnostics" | "native" | "nativeFallback">): PatchDef[] {
  const { bundle } = PLEX_ANCHORS;
  // Insert, right after the factory's "use strict", a getter that calls the
  // same service lookup the module uses for "appModel".
  const exposeAppModel = {
    match: new RegExp(`"use strict";(?=[\\s\\S]*?\\(0,([\\w$]+)\\.([\\w$]+)\\)\\(${bundle.appModelService.value}\\))`),
    replace: `"use strict";$self.registerAppModelGetter(()=>(0,$1.$2)(${bundle.appModelService.value}));`,
  };
  const playerPatch = (id: string, anchor: { value: string; status: string; source: string }, state: NativePlayerState): PatchDef => ({
    id,
    group: PLAYER_GROUP,
    find: [`"${anchor.value}"`, bundle.appModelService.value],
    note: `${anchor.status}: ${anchor.source}`,
    replacements: [exposeAppModel],
    onExports: (exports) => {
      const map = findHandlerMap(exports, anchor.value);
      if (!map) return false;
      state.handlers = map;
      return true;
    },
  });
  return [
    playerPatch(`${PLUGIN_NAME}/native-player`, bundle.startExistingPlayQueueAction, plugin.native),
    playerPatch(`${PLUGIN_NAME}/native-player-fallback`, bundle.queuePlaybackAction, plugin.nativeFallback),
    {
      id: `${PLUGIN_NAME}/context-menu-module`,
      find: bundle.contextMenuLabels.value.map((l) => `"${l}"`),
      optional: true,
      lazy: true,
      all: true,
      note: `${bundle.contextMenuLabels.status}: diagnostics only; the menu entry itself is added by the DOM integration`,
      onExports: (_exports, moduleId) => {
        plugin.diagnostics.contextMenuModules.push(moduleId);
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
  diagnostics: { contextMenuModules: [] },
  native: { handlers: null, getAppModel: null },
  nativeFallback: {
    handlers: null,
    get getAppModel() {
      return plugin.native.getAppModel;
    },
  },
  activePath: () => ({ path: null, reason: "play-from-here is not started" }),

  registerNativePlayer(player: NativePlayer) {
    plugin.nativePlayer = player;
  },

  registerAppModelGetter(getter: () => unknown) {
    plugin.native.getAppModel = getter;
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
    const preference = parsePlayerPreference(opt["pfh-player"]);
    const bindings = createDefaultBindings({
      location: win.location,
      tracker,
      fetch: (url, init) => win.fetch(url, init),
      playback: {
        nativePlayer: () => plugin.nativePlayer ?? (plugin.native.handlers && plugin.native.getAppModel ? createNativePlayer(plugin.native) : null),
        fallbackPlayer: () =>
          plugin.nativeFallback.handlers && plugin.nativeFallback.getAppModel ? createFallbackPlayer(plugin.nativeFallback) : null,
        preference,
        companionEnabled: parseCompanionEnabled(opt["pfh-companion"], preference),
        fetch: (url, init) => win.fetch(url, init),
        nextCommandId: () => ++commandId,
      },
    });
    plugin.activePath = () => bindings.playbackPath();
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
