import { describe, expect, it } from "vitest";
import {
  buildContainerPath,
  buildCreatePlayQueueRequest,
  buildGetPlayQueueRequest,
  buildListingUri,
  buildSectionPath,
  extractPlexClientHeaders,
  formatSort,
  itemsFromSelected,
  metadataKey,
  parseListingRequest,
  parsePlayQueue,
  parseSort,
  playQueueTypeFor,
  sanitizeListingParams,
} from "../patches/play-from-here/playqueue";

// Placeholders only (see CLAUDE.md): never real identifiers or hosts.
const server = { baseUrl: "https://plex-server.example:32400", machineIdentifier: "test-machine-identifier" };

/** Decodes the POST URL back into its parts for readable assertions. */
function decode(url: string) {
  const u = new URL(url);
  return { path: u.pathname, params: Object.fromEntries(u.searchParams), order: [...u.searchParams.keys()] };
}

describe("parseSort / formatSort", () => {
  it.each([
    ["titleSort", [{ field: "titleSort", modifiers: [] }]],
    ["year:desc", [{ field: "year", modifiers: ["desc"] }]],
    ["rating:desc:nullsLast", [{ field: "rating", modifiers: ["desc", "nullsLast"] }]],
    ["year:desc,titleSort", [{ field: "year", modifiers: ["desc"] }, { field: "titleSort", modifiers: [] }]],
    ["episode.addedAt:desc", [{ field: "episode.addedAt", modifiers: ["desc"] }]],
    [" addedAt:asc , titleSort ", [{ field: "addedAt", modifiers: ["asc"] }, { field: "titleSort", modifiers: [] }]],
  ])("parses %j", (input, expected) => {
    expect(parseSort(input)).toEqual(expected);
    expect(formatSort(parseSort(input))).toBe(input.replace(/\s/g, ""));
  });

  it.each(["", "year:", "year desc", "1year", "year;drop", "year:desc&x=1"])("rejects %j", (bad) => {
    expect(() => parseSort(bad)).toThrow();
  });
});

describe("sanitizeListingParams", () => {
  it("drops paging, presentation and X-Plex-* params, keeps type/sort/filters in order", () => {
    const p = sanitizeListingParams(
      "type=1&sort=year:desc&includeCollections=1&includeMeta=1&includeAdvanced=1&genre=12&unwatched=1" +
        "&X-Plex-Container-Start=0&X-Plex-Container-Size=50&X-Plex-Token=test-token&x-plex-product=Plex%20Web",
    );
    expect([...p]).toEqual([
      ["type", "1"],
      ["sort", "year:desc"],
      ["includeCollections", "1"],
      ["genre", "12"],
      ["unwatched", "1"],
    ]);
  });

  it("keeps advanced filter operators and grouping (push/or/pop) in order", () => {
    const p = sanitizeListingParams("type=1&push=1&year>>=2000&or=1&genre!=5&pop=1&sort=titleSort");
    expect([...p.keys()]).toEqual(["type", "push", "year>>", "or", "genre!", "pop", "sort"]);
  });

  it("supports extra drops (e.g. includeCollections) and accepts objects / URLSearchParams", () => {
    expect([...sanitizeListingParams({ type: "1", includeCollections: "1" }, ["includeCollections"])]).toEqual([["type", "1"]]);
    expect(sanitizeListingParams(new URLSearchParams("?sort=year:desc")).get("sort")).toBe("year:desc");
  });

  it("validates sort", () => {
    expect(() => sanitizeListingParams("sort=year:desc&x=1;drop")).not.toThrow();
    expect(() => sanitizeListingParams("sort=year%20desc")).toThrow(/invalid sort/);
  });
});

describe("buildSectionPath / buildListingUri", () => {
  it("builds the section listing path with readable sort", () => {
    expect(buildSectionPath(3, "type=1&sort=year:desc,titleSort")).toBe("/library/sections/3/all?type=1&sort=year:desc,titleSort");
    expect(buildSectionPath("7", "")).toBe("/library/sections/7/all");
  });

  it("percent-encodes filter values and operators", () => {
    expect(buildSectionPath(1, { type: "1", title: "Star Wars & Co", "year>>": "2000" })).toBe(
      "/library/sections/1/all?type=1&title=Star%20Wars%20%26%20Co&year%3E%3E=2000",
    );
  });

  it("builds a server:// URI", () => {
    expect(buildListingUri(server, { sectionId: 2, params: "type=2&sort=addedAt:desc" })).toBe(
      "server://test-machine-identifier/com.plexapp.plugins.library/library/sections/2/all?type=2&sort=addedAt:desc",
    );
  });

  it("builds a library:// URI with the encoded directory path", () => {
    expect(
      buildListingUri(server, { sectionId: 2, params: "type=1&sort=year:desc", librarySectionUUID: "test-section-uuid" }, "library"),
    ).toBe("library://test-section-uuid/directory/%2Flibrary%2Fsections%2F2%2Fall%3Ftype%3D1%26sort%3Dyear%3Adesc");
  });

  it.each([
    [{ sectionId: "1; DROP", params: "" }, /section id/],
    [{ sectionId: "abc", params: "" }, /section id/],
  ])("rejects bad section ids", (listing, err) => {
    expect(() => buildListingUri(server, listing)).toThrow(err);
  });

  it("rejects unsafe machine identifiers and missing UUIDs", () => {
    expect(() => buildListingUri({ machineIdentifier: "a/b" }, { sectionId: 1, params: "" })).toThrow(/machineIdentifier/);
    expect(() => buildListingUri(server, { sectionId: 1, params: "" }, "library")).toThrow(/librarySectionUUID/);
  });
});

describe("buildContainerPath", () => {
  it("builds section and children paths with sanitized queries", () => {
    expect(buildContainerPath({ sectionId: 2, params: "type=1&sort=year:desc&X-Plex-Container-Start=0" })).toBe("/library/sections/2/all?type=1&sort=year:desc");
    expect(buildContainerPath({ containerPath: "/library/metadata/8/children", params: "excludeAllLeaves=1&includeMeta=1" })).toBe(
      "/library/metadata/8/children?excludeAllLeaves=1",
    );
    expect(buildListingUri(server, { containerPath: "/library/metadata/8/children", params: "" })).toBe(
      "server://test-machine-identifier/com.plexapp.plugins.library/library/metadata/8/children",
    );
  });

  it("rejects other containers and missing ids", () => {
    expect(() => buildContainerPath({ containerPath: "/library/metadata/8/related", params: "" })).toThrow(/unsupported container path/);
    expect(() => buildContainerPath({ params: "" })).toThrow(/sectionId or a containerPath/);
  });
});

describe("playQueueTypeFor", () => {
  it.each([
    [1, "video"],
    ["2", "video"],
    [4, "video"],
    ["movie", "video"],
    ["episode", "video"],
    [8, "audio"],
    [9, "audio"],
    [10, "audio"],
    ["track", "audio"],
    [13, "photo"],
    ["photoalbum", "photo"],
    [undefined, "video"],
  ] as const)("%j -> %s", (t, expected) => {
    expect(playQueueTypeFor(t)).toBe(expected);
  });

  it("rejects types that cannot be queued", () => {
    expect(() => playQueueTypeFor(15)).toThrow(/unsupported/);
    expect(() => playQueueTypeFor("person")).not.toThrow(); // unknown names fall back to video
  });
});

describe("buildCreatePlayQueueRequest", () => {
  it("creates a sorted section queue starting at the clicked item", () => {
    const req = buildCreatePlayQueueRequest({
      server,
      listing: { sectionId: 1, params: "type=1&sort=year:desc&X-Plex-Container-Start=0&X-Plex-Container-Size=50" },
      item: { ratingKey: 12345 },
      headers: { "X-Plex-Token": "test-token", "X-Plex-Client-Identifier": "test-client" },
    });
    expect(req.method).toBe("POST");
    const d = decode(req.url);
    expect(d.path).toBe("/playQueues");
    expect(d.order).toEqual(["type", "uri", "key", "shuffle", "repeat"]);
    expect(d.params).toEqual({
      type: "video",
      uri: "server://test-machine-identifier/com.plexapp.plugins.library/library/sections/1/all?type=1&sort=year:desc",
      key: "/library/metadata/12345",
      shuffle: "0",
      repeat: "0",
    });
    expect(req.headers).toEqual({ Accept: "application/json", "X-Plex-Token": "test-token", "X-Plex-Client-Identifier": "test-client" });
    expect(req.url).not.toMatch(/X-Plex-Token/);
  });

  it("strictly encodes the uri param (no raw & or ? leak into the outer query)", () => {
    const req = buildCreatePlayQueueRequest({
      server,
      listing: { sectionId: 4, params: "type=10&sort=album.titleSort,index&mood=7" },
      item: { ratingKey: "99" },
    });
    expect(req.url).toBe(
      "https://plex-server.example:32400/playQueues?type=audio" +
        "&uri=server%3A%2F%2Ftest-machine-identifier%2Fcom.plexapp.plugins.library%2Flibrary%2Fsections%2F4%2Fall%3Ftype%3D10%26sort%3Dalbum.titleSort%2Cindex%26mood%3D7" +
        "&key=%2Flibrary%2Fmetadata%2F99&shuffle=0&repeat=0",
    );
  });

  it("double-encodes filter values inside the uri so they survive both decodes", () => {
    const req = buildCreatePlayQueueRequest({ server, listing: { sectionId: 1, params: { type: "1", title: "A&B" } }, item: { ratingKey: 1 } });
    const inner = decode(req.url).params.uri!;
    expect(inner).toBe("server://test-machine-identifier/com.plexapp.plugins.library/library/sections/1/all?type=1&title=A%26B");
    expect(new URL(inner.replace(/^server:\/\/[^/]+/, "http://x")).searchParams.get("title")).toBe("A&B");
  });

  it("uses the item type when the listing has no type param", () => {
    const req = buildCreatePlayQueueRequest({ server, listing: { sectionId: 5, params: "" }, item: { ratingKey: 3, type: "track" } });
    expect(decode(req.url).params.type).toBe("audio");
  });

  it("keeps a reverse-proxy path prefix and drops trailing slashes", () => {
    const req = buildCreatePlayQueueRequest({
      server: { ...server, baseUrl: "https://proxy.example/plex/" },
      listing: { sectionId: 1, params: "type=1" },
      item: { ratingKey: 1 },
    });
    expect(req.url.startsWith("https://proxy.example/plex/playQueues?")).toBe(true);
  });

  it("supports the library:// scheme, repeat and extra params", () => {
    const req = buildCreatePlayQueueRequest({
      server,
      scheme: "library",
      listing: { sectionId: 2, params: "type=4&sort=originallyAvailableAt", librarySectionUUID: "test-section-uuid" },
      item: { ratingKey: 77 },
      repeat: 1,
      extraParams: { includeChapters: "1" },
    });
    const d = decode(req.url);
    expect(d.params.uri).toBe("library://test-section-uuid/directory/%2Flibrary%2Fsections%2F2%2Fall%3Ftype%3D4%26sort%3DoriginallyAvailableAt");
    expect(d.params.repeat).toBe("1");
    expect(d.params.includeChapters).toBe("1");
  });

  it("refuses to put the token in the URL", () => {
    expect(() =>
      buildCreatePlayQueueRequest({ server, listing: { sectionId: 1, params: "" }, item: { ratingKey: 1 }, extraParams: { "X-Plex-Token": "t" } }),
    ).toThrow(/header/);
  });

  it("rejects bad rating keys and base URLs", () => {
    expect(() => buildCreatePlayQueueRequest({ server, listing: { sectionId: 1, params: "" }, item: { ratingKey: "../1" } })).toThrow(/ratingKey/);
    expect(() =>
      buildCreatePlayQueueRequest({ server: { ...server, baseUrl: "javascript:alert(1)" }, listing: { sectionId: 1, params: "" }, item: { ratingKey: 1 } }),
    ).toThrow(/protocol/);
  });
});

describe("metadataKey / buildGetPlayQueueRequest", () => {
  it("builds keys and GET requests", () => {
    expect(metadataKey("42")).toBe("/library/metadata/42");
    expect(buildGetPlayQueueRequest(server.baseUrl, 314, { window: 200, own: true }).url).toBe(
      "https://plex-server.example:32400/playQueues/314?window=200&own=1",
    );
    expect(buildGetPlayQueueRequest(server.baseUrl, "5").url).toBe("https://plex-server.example:32400/playQueues/5");
  });
});

describe("parsePlayQueue / itemsFromSelected", () => {
  const response = {
    MediaContainer: {
      playQueueID: 314,
      playQueueSelectedItemID: 1002,
      playQueueSelectedItemOffset: 1,
      playQueueSelectedMetadataItemID: "20",
      playQueueTotalCount: 3,
      playQueueVersion: 1,
      Metadata: [
        { ratingKey: "10", playQueueItemID: 1001, type: "movie" },
        { ratingKey: "20", playQueueItemID: 1002, type: "movie" },
        { ratingKey: "30", playQueueItemID: 1003, type: "movie" },
      ],
    },
  };

  it("parses ids, offsets and items", () => {
    const q = parsePlayQueue(response);
    expect(q).toMatchObject({ id: "314", selectedItemId: "1002", selectedItemOffset: 1, selectedRatingKey: "20", totalCount: 3, version: 1 });
    expect(q.items.map((i) => i.ratingKey)).toEqual(["10", "20", "30"]);
    expect(itemsFromSelected(q)).toEqual(["20", "30"]);
  });

  it("falls back to the selected rating key, then to the start", () => {
    const q = parsePlayQueue({ MediaContainer: { playQueueID: 1, playQueueSelectedMetadataItemID: 30, Metadata: [{ ratingKey: 10 }, { ratingKey: 30 }] } });
    expect(itemsFromSelected(q)).toEqual(["30"]);
    expect(itemsFromSelected(parsePlayQueue({ MediaContainer: { playQueueID: 1, Metadata: [{ ratingKey: 1 }] } }))).toEqual(["1"]);
  });

  it("rejects non-queue responses", () => {
    expect(() => parsePlayQueue({ MediaContainer: {} })).toThrow(/not a play queue/);
    expect(() => parsePlayQueue(null)).toThrow();
  });
});

describe("parseListingRequest / extractPlexClientHeaders", () => {
  it("recognizes section listing requests, keeping a path prefix", () => {
    expect(parseListingRequest("https://plex-server.example:32400/library/sections/3/all?type=1&sort=year:desc")).toMatchObject({
      baseUrl: "https://plex-server.example:32400",
      sectionId: "3",
    });
    const r = parseListingRequest("/plex/library/sections/12/all?type=2", "https://proxy.example");
    expect(r?.baseUrl).toBe("https://proxy.example/plex");
    expect(r?.params.get("type")).toBe("2");
  });

  it("recognizes children listings (e.g. a season's episodes)", () => {
    expect(parseListingRequest("https://plex-server.example:32400/library/metadata/8/children?excludeAllLeaves=1")).toMatchObject({
      baseUrl: "https://plex-server.example:32400",
      containerPath: "/library/metadata/8/children",
      parentRatingKey: "8",
    });
  });

  it("ignores Plex Web's background hub queries on the same endpoint", () => {
    expect(parseListingRequest("https://plex-server.example:32400/library/sections/1/all?sort=addedAt:desc&contentDirectoryID=1&pinnedContentDirectoryID=2,1")).toBeNull();
    expect(parseListingRequest("https://plex-server.example:32400/library/sections/1/all?type=1&sort=addedAt:desc")?.containerPath).toBe("/library/sections/1/all");
  });

  it.each([
    "https://plex-server.example:32400/library/sections",
    "https://plex-server.example:32400/library/sections/3/firstCharacter",
    "https://plex-server.example:32400/hubs/sections/3",
    "https://plex-server.example:32400/library/metadata/5",
    "not a url",
  ])("ignores %s", (url) => {
    expect(parseListingRequest(url)).toBeNull();
  });

  it("extracts X-Plex-* client values from query and headers, without paging params", () => {
    const h = extractPlexClientHeaders(
      "https://plex-server.example:32400/library/sections/1/all?X-Plex-Product=Plex%20Web&X-Plex-Container-Start=0&x-plex-token=from-query",
      { "x-plex-client-identifier": "test-client", "X-Plex-Token": "from-header", Accept: "application/json" },
    );
    expect(h).toEqual({ "X-Plex-Product": "Plex Web", "X-Plex-Token": "from-header", "X-Plex-Client-Identifier": "test-client" });
  });
});
