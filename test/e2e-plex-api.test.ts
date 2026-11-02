// The e2e's PMS API client (e2e/plex-api.ts) against a fake request context.
import { describe, expect, it } from "vitest";
import { PlexApi } from "../e2e/plex-api";

/** A fake PMS section listing of `total` items; reports totalSize unless told not to. */
function fakeListing(total: number, opts: { totalSize?: boolean } = {}) {
  const urls: URL[] = [];
  const request = {
    async get(url: string, init: { headers: Record<string, string> }) {
      const u = new URL(url);
      urls.push(u);
      expect(init.headers["X-Plex-Token"]).toBe("test-token");
      const start = Number(u.searchParams.get("X-Plex-Container-Start"));
      const size = Number(u.searchParams.get("X-Plex-Container-Size"));
      const keys = Array.from({ length: Math.max(0, Math.min(size, total - start)) }, (_, i) => ({ ratingKey: start + i + 1 }));
      const mc: Record<string, unknown> = { size: keys.length, Metadata: keys };
      if (opts.totalSize !== false) mc.totalSize = total;
      return { ok: () => true, status: () => 200, json: async () => ({ MediaContainer: mc }) };
    },
  };
  return { api: new PlexApi(request as any, "https://plex.example:32400", "test-token"), urls };
}

const expected = (n: number) => Array.from({ length: n }, (_, i) => String(i + 1));

describe("PlexApi.listingKeys", () => {
  it("pages through a listing larger than one page (a real library)", async () => {
    const { api, urls } = fakeListing(2641);
    const keys = await api.listingKeys("5", new URLSearchParams("type=1&sort=addedAt:desc"));
    expect(keys).toEqual(expected(2641));
    expect(urls.map((u) => u.searchParams.get("X-Plex-Container-Start"))).toEqual(["0", "1000", "2000"]);
    expect(urls.every((u) => u.pathname === "/library/sections/5/all" && u.searchParams.get("sort") === "addedAt:desc")).toBe(true);
  });

  it("stops at a short page when PMS reports no totalSize", async () => {
    const { api, urls } = fakeListing(250, { totalSize: false });
    expect(await api.listingKeys("7", new URLSearchParams("sort=year"), 100)).toEqual(expected(250));
    expect(urls).toHaveLength(3);
  });

  it("makes one extra request at most when the listing ends on a page boundary", async () => {
    const { api, urls } = fakeListing(200, { totalSize: false });
    expect(await api.listingKeys("7", new URLSearchParams(), 100)).toEqual(expected(200));
    expect(urls).toHaveLength(3);
  });

  it("returns an empty list for an empty section", async () => {
    const { api } = fakeListing(0);
    expect(await api.listingKeys("7", new URLSearchParams())).toEqual([]);
  });

  it("caps the number of items it reads", async () => {
    const { api } = fakeListing(10_000);
    expect(await api.listingKeys("7", new URLSearchParams(), 1000, 3000)).toHaveLength(3000);
  });
});
