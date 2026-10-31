import { afterEach, describe, expect, it, vi } from "vitest";
import { PatchSession } from "../runtime/engine";
import { installWebpackHooks, type WebpackHooks } from "../runtime/loader";
import plugin from "../patches/play-from-here/index";
import { createNativePlayer, findHandlerMap, resolveEntities } from "../patches/play-from-here/native-player";
import { PLEX_ANCHORS } from "../patches/play-from-here/plex-anchors";
import type { PlaybackRequest } from "../patches/play-from-here/bindings";
import { bundleFixture, createRealm } from "./helpers/realm";

const ACTION = PLEX_ANCHORS.bundle.startExistingPlayQueueAction.value;

/** Backbone-ish fake of the bits of Plex Web's appModel the adapter touches. */
function fakeAppModel(opts: { server?: boolean; provider?: boolean } = {}) {
  const provider = { entityID: () => "provider-entity", populate: () => Promise.resolve(provider) };
  const server = {
    entityID: () => "server-entity",
    get: (k: string) => (k === "providers" ? { populate: () => Promise.resolve({ get: (id: string) => (opts.provider === false ? undefined : id === "com.plexapp.plugins.library" ? provider : undefined) }) } : undefined),
  };
  const servers = { populateServer: vi.fn((_id: string) => Promise.resolve(opts.server === false ? null : server)) };
  return { get: (k: string) => (k === "servers" ? servers : undefined), entityID: () => "app", servers };
}

const req: PlaybackRequest = {
  queue: { id: "42", items: [] },
  playQueueType: "video",
  item: { ratingKey: "7" },
  server: { baseUrl: "http://plex-server.example:32400", machineIdentifier: "test-machine-identifier", headers: {} },
};

describe("findHandlerMap", () => {
  it("finds the handler map among (getter) exports by its action-type key", () => {
    const map = { [ACTION]: () => {}, other: () => {} };
    const exports = {};
    Object.defineProperty(exports, "zz", { enumerable: true, get: () => "x" });
    Object.defineProperty(exports, "D0", { enumerable: true, get: () => map });
    expect(findHandlerMap(exports, ACTION)).toBe(map);
    expect(findHandlerMap({ a: {} }, ACTION)).toBeNull();
    expect(findHandlerMap(null, ACTION)).toBeNull();
  });
});

describe("createNativePlayer", () => {
  it("resolves server/provider entities and calls Plex Web's handler with the queue", async () => {
    const app = fakeAppModel();
    const handler = vi.fn();
    await createNativePlayer({ handlers: { [ACTION]: handler }, getAppModel: () => app }).play(req);
    expect(app.servers.populateServer).toHaveBeenCalledWith("test-machine-identifier");
    expect(handler).toHaveBeenCalledWith(app, expect.objectContaining({
      serverEntityID: "server-entity",
      providerEntityID: "provider-entity",
      playQueueType: "video",
      playQueueID: 42,
    }));
  });

  it("fails with a specific reason when a piece is missing", async () => {
    await expect(createNativePlayer({ handlers: null, getAppModel: () => fakeAppModel() }).play(req)).rejects.toThrow(/not captured/);
    await expect(createNativePlayer({ handlers: { [ACTION]: vi.fn() }, getAppModel: null }).play(req)).rejects.toThrow(/appModel not available/);
    await expect(resolveEntities(fakeAppModel({ server: false }) as any, "x")).rejects.toThrow(/does not know server/);
    await expect(resolveEntities(fakeAppModel({ provider: false }) as any, "x")).rejects.toThrow(/no com.plexapp.plugins.library provider/);
    await expect(resolveEntities({ get: () => undefined, entityID: () => 1 } as any, "x")).rejects.toThrow(/populateServer is not available/);
  });
});

describe("play-from-here native-player patch on a Plex-shaped bundle", () => {
  let hooks: WebpackHooks | null = null;
  afterEach(() => {
    hooks?.uninstall();
    plugin.native.handlers = null;
    plugin.native.getAppModel = null;
  });

  it("captures the handler map, exposes appModel via $self, and starts playback through the handler", async () => {
    const realm = createRealm();
    const session = new PatchSession([plugin]);
    hooks = installWebpackHooks({ session, target: realm.global, chunkGlobals: [] });
    realm.global.__plexwebMods = { plugins: { [plugin.name]: plugin } };
    realm.runFile(bundleFixture("wp5-plex-shape", "js", "main.js"));

    const report = session.report({ final: true });
    expect(report.failures).toEqual([]);
    expect(report.entries.find((e) => e.patchId === "play-from-here/native-player")).toMatchObject({ status: "applied", located: ["600"], applied: ["600"] });
    expect(typeof plugin.native.handlers?.[ACTION]).toBe("function");
    const app = plugin.native.getAppModel!() as any;
    expect(app.entityID()).toBe("app");

    await createNativePlayer(plugin.native).play(req);
    expect(app.get("player").started).toMatchObject({ serverEntityID: "server-entity", providerEntityID: "provider-entity", playQueueID: 42, playQueueType: "video" });
  });
});
