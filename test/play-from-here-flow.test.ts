import { describe, expect, it, vi } from "vitest";
import type { ListingContext, PlexBindings, ServerContext } from "../patches/play-from-here/bindings";
import { createDefaultBindings, parseRoute } from "../patches/play-from-here/default-bindings";
import { PlayFromHereError, runPlayFromHere } from "../patches/play-from-here/flow";
import { ListingTracker } from "../patches/play-from-here/network-observer";
import { buildCompanionPlayMediaRequest, choosePath, parseCompanionEnabled, parsePlayerPreference, startPlayback, type PlaybackDeps } from "../patches/play-from-here/playback";
import plugin from "../patches/play-from-here/index";
import { PatchSession } from "../runtime/engine";

const BASE = "https://plex-server.example:32400";
const listing: ListingContext = {
  baseUrl: BASE,
  containerPath: "/library/sections/1/all",
  sectionId: "1",
  params: new URLSearchParams("type=1&sort=year:desc&X-Plex-Container-Start=0"),
  observedAt: 1,
};
const server: ServerContext = { baseUrl: BASE, machineIdentifier: "test-machine-identifier", headers: { "X-Plex-Token": "test-token", "X-Plex-Client-Identifier": "test-client" } };
const queueJson = { MediaContainer: { playQueueID: 9, playQueueSelectedItemID: 2, Metadata: [{ ratingKey: "5", playQueueItemID: 2 }] } };

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

function bindings(over: Partial<PlexBindings> = {}): PlexBindings {
  return {
    currentListing: () => listing,
    serverFor: async () => server,
    playbackPath: () => ({ path: "native" }),
    startPlayback: async () => "native",
    ...over,
  };
}

describe("runPlayFromHere", () => {
  it("POSTs the sorted section queue and hands it to the player", async () => {
    const fetch = vi.fn(async () => ok(queueJson));
    const startPlayback = vi.fn(async () => "native" as const);
    const r = await runPlayFromHere({ bindings: bindings({ startPlayback }), fetch }, { ratingKey: "5" });
    expect(r).toMatchObject({ playback: "native", queue: { id: "9" } });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-Plex-Token"]).toBe("test-token");
    const q = new URL(url).searchParams;
    expect(q.get("uri")).toBe("server://test-machine-identifier/com.plexapp.plugins.library/library/sections/1/all?type=1&sort=year:desc");
    expect(q.get("key")).toBe("/library/metadata/5");
    expect(q.get("shuffle")).toBe("0");
    expect(startPlayback).toHaveBeenCalledWith(expect.objectContaining({ item: { ratingKey: "5" }, server, playQueueType: "video" }));
  });

  it.each([
    ["listing", { bindings: bindings({ currentListing: () => null }), fetch: async () => ok(queueJson) }],
    ["server", { bindings: bindings({ serverFor: async () => { throw new Error("no identity"); } }), fetch: async () => ok(queueJson) }],
    ["create-queue", { bindings: bindings(), fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }) }],
    ["create-queue", { bindings: bindings(), fetch: async () => ok({ nope: 1 }) }],
    ["playback", { bindings: bindings({ startPlayback: async () => { throw new Error("no player"); } }), fetch: async () => ok(queueJson) }],
    ["playback", { bindings: bindings({ playbackPath: () => ({ path: null, reason: "nothing resolved" }) }), fetch: async () => ok(queueJson) }],
  ] as const)("fails at step %s with a specific error", async (step, deps) => {
    const err = await runPlayFromHere(deps as any, { ratingKey: "5" }).catch((e) => e);
    expect(err).toBeInstanceOf(PlayFromHereError);
    expect(err.step).toBe(step);
    expect(err.message).toMatch(new RegExp(`^play-from-here \\[${step}\\]: `));
  });
});

describe("runPlayFromHere on a children listing (season view)", () => {
  it("queues the season's children from the clicked episode, asking the server for the type", async () => {
    const season: ListingContext = { baseUrl: BASE, containerPath: "/library/metadata/8/children", parentRatingKey: "8", params: new URLSearchParams("excludeAllLeaves=1"), observedAt: 1 };
    const fetch = vi.fn(async () => ok(queueJson));
    const itemType = vi.fn(async () => "episode");
    const startPlayback = vi.fn(async () => "native" as const);
    await runPlayFromHere({ bindings: bindings({ currentListing: () => season, itemType, startPlayback }), fetch }, { ratingKey: "11" });
    const q = new URL((fetch.mock.calls[0] as unknown as [string])[0]).searchParams;
    expect(q.get("uri")).toBe("server://test-machine-identifier/com.plexapp.plugins.library/library/metadata/8/children?excludeAllLeaves=1");
    expect(q.get("key")).toBe("/library/metadata/11");
    expect(q.get("type")).toBe("video");
    expect(itemType).toHaveBeenCalledWith(server, "11");
  });
});

describe("startPlayback", () => {
  const req = { queue: { id: "9", items: [], selectedRatingKey: "5" }, server, item: { ratingKey: "5" }, playQueueType: "video" as const };
  const deps = (over: Partial<PlaybackDeps>): PlaybackDeps => ({
    nativePlayer: () => null,
    fallbackPlayer: () => null,
    preference: "auto",
    companionEnabled: true,
    fetch: vi.fn(),
    nextCommandId: () => 1,
    ...over,
  });

  it("chooses native, then native-fallback, then companion; a forced preference never silently falls through", () => {
    const p = { play: vi.fn() };
    expect(choosePath(deps({ nativePlayer: () => p, fallbackPlayer: () => p }))).toEqual({ path: "native" });
    expect(choosePath(deps({ fallbackPlayer: () => p }))).toEqual({ path: "native-fallback" });
    expect(choosePath(deps({}))).toEqual({ path: "companion" });
    expect(choosePath(deps({ companionEnabled: false })).path).toBeNull();
    expect(choosePath(deps({ preference: "fallback", nativePlayer: () => p, fallbackPlayer: () => p }))).toEqual({ path: "native-fallback" });
    expect(choosePath(deps({ preference: "fallback", nativePlayer: () => p }))).toMatchObject({ path: null, reason: expect.stringMatching(/native-player-fallback/) });
    expect(choosePath(deps({ preference: "primary", fallbackPlayer: () => p }))).toMatchObject({ path: null, reason: expect.stringMatching(/play-from-here\/native-player\)/) });
    expect(choosePath(deps({ preference: "companion", nativePlayer: () => p }))).toEqual({ path: "companion" });
    expect(parsePlayerPreference("fallback")).toBe("fallback");
    expect(parsePlayerPreference("bogus")).toBe("auto");
  });

  it("keeps the companion fallback off unless enabled or forced (PMS rejects it for Plex Web)", () => {
    expect(parseCompanionEnabled(undefined, "auto")).toBe(false);
    expect(parseCompanionEnabled("bogus", "auto")).toBe(false);
    expect(parseCompanionEnabled("on", "auto")).toBe(true);
    expect(parseCompanionEnabled(undefined, "companion")).toBe(true);
    expect(parseCompanionEnabled("off", "companion")).toBe(false);
    expect(choosePath(deps({ companionEnabled: parseCompanionEnabled(undefined, "auto") }))).toMatchObject({ path: null });
  });

  it("runs the fallback player when it is the chosen path", async () => {
    const play = vi.fn();
    await expect(startPlayback(deps({ preference: "fallback", fallbackPlayer: () => ({ play }) }), req)).resolves.toBe("native-fallback");
    expect(play).toHaveBeenCalledWith(req);
  });

  it("prefers the native player hook", async () => {
    const play = vi.fn();
    const fetch = vi.fn();
    await expect(startPlayback(deps({ nativePlayer: () => ({ play }), fetch }), req)).resolves.toBe("native");
    expect(play).toHaveBeenCalledWith(req);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("falls back to the companion command targeted at this client", async () => {
    const fetch = vi.fn(async () => ({ ok: true, status: 200 }));
    await expect(startPlayback(deps({ fetch, nextCommandId: () => 7 }), req)).resolves.toBe("companion");
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const u = new URL(url);
    expect(u.pathname).toBe("/player/playback/playMedia");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      containerKey: "/playQueues/9?own=1&window=200",
      key: "/library/metadata/5",
      machineIdentifier: "test-machine-identifier",
      protocol: "https",
      address: "plex-server.example",
      port: "32400",
      commandID: "7",
      type: "video",
    });
    expect((init.headers as Record<string, string>)["X-Plex-Target-Client-Identifier"]).toBe("test-client");
  });

  it("explains exactly why playback is unavailable", async () => {
    await expect(startPlayback(deps({ companionEnabled: false }), req)).rejects.toThrow(/neither native player path is resolved/);
    await expect(startPlayback(deps({ fetch: async () => ({ ok: false, status: 404 }) }), req)).rejects.toThrow(/companion fallback failed with HTTP 404/);
    await expect(startPlayback(deps({}), { ...req, server: { ...server, headers: {} } })).rejects.toThrow(/no X-Plex-Client-Identifier/);
  });

  it("companion request uses default ports", () => {
    const r = buildCompanionPlayMediaRequest({ ...req, server: { ...server, baseUrl: "http://plex-server.example" } }, { targetClientIdentifier: "c", commandId: 1 });
    expect(new URL(r.url).searchParams.get("port")).toBe("80");
  });
});

describe("parseRoute", () => {
  it.each([
    ["#!/media/test-machine-identifier/com.plexapp.plugins.library?source=3&pivot=library", { isListing: true, kind: "section", machineIdentifier: "test-machine-identifier", sectionId: "3" }],
    ["#!/media/abc123/com.plexapp.plugins.library?pivot=library&source=12", { isListing: true, kind: "section", machineIdentifier: "abc123", sectionId: "12" }],
    ["#!/media/abc123/com.plexapp.plugins.library?source=12", { isListing: false, kind: "other", machineIdentifier: "abc123" }], // "Recommended" tab
    ["#!/server/abc123/details?key=%2Flibrary%2Fmetadata%2F5", { isListing: true, kind: "details", machineIdentifier: "abc123", parentRatingKey: "5" }],
    ["#!/server/abc123/details?key=%2Flibrary%2Fmetadata%2F8&context=source%3Acontent.library~0~0", { isListing: true, kind: "details", machineIdentifier: "abc123", parentRatingKey: "8" }],
    ["#!/server/abc123/details?key=%2Flibrary%2Fmetadata%2F58", { isListing: true, kind: "details", machineIdentifier: "abc123", parentRatingKey: "58" }],
    ["#!/server/abc123/activity", { isListing: false, kind: "other", machineIdentifier: "abc123" }],
    ["#!/", { isListing: false, kind: "other" }],
  ])("%s", (hash, expected) => {
    expect(parseRoute(hash)).toEqual(expected);
  });
});

describe("createDefaultBindings", () => {
  function setup(hash = "#!/media/route-machine/com.plexapp.plugins.library?source=1&pivot=library", identity: unknown = { MediaContainer: { machineIdentifier: "identity-machine" } }) {
    const tracker = new ListingTracker(() => `${BASE}/web/index.html`, () => 100);
    tracker.observe({ url: `${BASE}/library/sections/1/all?type=1&sort=year:desc&X-Plex-Token=test-token`, headers: { "X-Plex-Client-Identifier": "test-client" } });
    tracker.observe({ url: `${BASE}/library/sections/2/all?type=2`, headers: {} });
    const fetch = vi.fn(async () => (identity ? ok(identity) : { ok: false, status: 500, json: async () => ({}) }));
    const b = createDefaultBindings({
      location: { hash },
      tracker,
      fetch,
      playback: { nativePlayer: () => null, fallbackPlayer: () => null, preference: "auto", companionEnabled: false, fetch: vi.fn(), nextCommandId: () => 1 },
    });
    return { b, fetch };
  }

  it("prefers the listing of the section in the current route", () => {
    expect(setup().b.currentListing()?.sectionId).toBe("1");
    expect(setup("#!/").b.currentListing()?.sectionId).toBe("2"); // most recent overall
    expect(setup("#!/server/route-machine/details?key=%2Flibrary%2Fmetadata%2F99").b.currentListing()).toBeNull(); // no children listed
    expect(setup().b.playbackPath()).toMatchObject({ path: null });
  });

  it("resolves the machine identifier via /identity once per server, with client headers", async () => {
    const { b, fetch } = setup();
    const l = b.currentListing()!;
    const s1 = await b.serverFor(l);
    await b.serverFor(l);
    expect(s1).toEqual({ baseUrl: BASE, machineIdentifier: "identity-machine", headers: { "X-Plex-Token": "test-token", "X-Plex-Client-Identifier": "test-client" } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe(`${BASE}/identity`);
  });

  it("falls back to the route's machine identifier when /identity fails", async () => {
    const { b } = setup(undefined, null);
    expect((await b.serverFor(b.currentListing()!)).machineIdentifier).toBe("route-machine");
    const { b: b2 } = setup("#!/", null);
    await expect(b2.serverFor(b2.currentListing()!)).rejects.toThrow(/machine identifier/);
  });
});

describe("play-from-here patch definitions", () => {
  it("are valid for the engine and group the two native player paths", () => {
    const s = new PatchSession([plugin]);
    const entries = s.report().entries;
    expect(entries.map((e) => [e.patchId, e.group ?? null])).toEqual([
      ["play-from-here/native-player", "play-from-here/player"],
      ["play-from-here/native-player-fallback", "play-from-here/player"],
      ["play-from-here/context-menu-module", null],
    ]);
    expect(plugin.patches.some((p) => p.todo)).toBe(false);
  });
});
