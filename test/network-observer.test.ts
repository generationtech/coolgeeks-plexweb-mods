// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { installNetworkObserver, ListingTracker, type ObservedRequest } from "../patches/play-from-here/network-observer";

const BASE = "https://plex-server.example:32400";
const undo: Array<() => void> = [];
afterEach(() => undo.splice(0).forEach((f) => f()));

describe("installNetworkObserver", () => {
  it("observes fetch (string, URL, Request) without altering the call", async () => {
    const seen: ObservedRequest[] = [];
    const inner = vi.fn(async () => new Response("{}"));
    const win = { fetch: inner as unknown as typeof fetch, location: { href: `${BASE}/web/` } };
    undo.push(installNetworkObserver(win, (r) => seen.push(r)));
    await win.fetch(`${BASE}/a`, { headers: { "X-Plex-Token": "test-token" } });
    await win.fetch(new URL(`${BASE}/b`));
    await win.fetch(new Request(`${BASE}/c`, { headers: { "X-Plex-Client-Identifier": "test-client" } }), { headers: [["x-extra", "1"]] });
    expect(inner).toHaveBeenCalledTimes(3);
    expect(seen.map((s) => s.url)).toEqual([`${BASE}/a`, `${BASE}/b`, `${BASE}/c`]);
    expect(seen[0]!.headers).toEqual({ "X-Plex-Token": "test-token" });
    expect(seen[2]!.headers).toEqual({ "x-plex-client-identifier": "test-client", "x-extra": "1" });
  });

  it("observes XMLHttpRequest open/setRequestHeader/send and restores on uninstall", () => {
    const seen: ObservedRequest[] = [];
    const origOpen = XMLHttpRequest.prototype.open;
    const off = installNetworkObserver(window as any, (r) => seen.push(r));
    const xhr = new XMLHttpRequest();
    xhr.open("GET", `${BASE}/library/sections/1/all?type=1`);
    xhr.setRequestHeader("X-Plex-Token", "test-token");
    try {
      xhr.send();
    } catch {
      /* jsdom may refuse the network; we only care about observation */
    }
    xhr.abort();
    expect(seen).toEqual([{ url: `${BASE}/library/sections/1/all?type=1`, headers: { "X-Plex-Token": "test-token" } }]);
    off();
    expect(XMLHttpRequest.prototype.open).toBe(origOpen);
  });

  it("an observer that throws never breaks the request", async () => {
    const inner = vi.fn(async () => new Response("ok"));
    const win = { fetch: inner as unknown as typeof fetch, location: { href: BASE } };
    undo.push(installNetworkObserver(win, () => { throw new Error("observer bug"); }));
    await expect(win.fetch(`${BASE}/x`).then((r) => r.text())).resolves.toBe("ok");
  });
});

describe("ListingTracker", () => {
  it("tracks the latest listing per section and client headers per origin", () => {
    let t = 0;
    const tr = new ListingTracker(() => `${BASE}/web/index.html`, () => ++t);
    tr.observe({ url: "/library/sections/1/all?type=1&sort=titleSort", headers: {} });
    tr.observe({ url: "/library/sections/1/all?type=1&sort=year:desc", headers: { "X-Plex-Token": "test-token" } });
    tr.observe({ url: "/hubs/sections/1", headers: { "X-Plex-Client-Identifier": "test-client" } });
    tr.observe({ url: "/library/sections/4/all?type=8", headers: {} });
    expect(tr.current("1")?.params.get("sort")).toBe("year:desc");
    expect(tr.current()?.sectionId).toBe("4");
    expect(tr.current("9")).toBeNull();
    expect(tr.headersFor(BASE)).toEqual({ "X-Plex-Token": "test-token", "X-Plex-Client-Identifier": "test-client" });
    expect(tr.headersFor("https://other.example")).toEqual({});
  });
});
