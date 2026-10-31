/**
 * Pure construction of the Plex Media Server requests behind "Play from here".
 *
 *   POST {base}/playQueues?type=<video|audio|photo>
 *        &uri=<source uri: the section listing, with the visible sort/filters>
 *        &key=/library/metadata/<ratingKey of the clicked item>
 *        &shuffle=0&repeat=0
 *
 * The source uri is a Plex "content URI":
 *   server://<machineIdentifier>/com.plexapp.plugins.library/library/sections/<id>/all?type=1&sort=year:desc
 * or the older form
 *   library://<librarySectionUUID>/directory/<url-encoded section path>
 *
 * No DOM, no fetch: everything here is unit-tested.
 */

/** Plex metadata type numbers (as used in `type=` listing params). */
export const PlexType = {
  movie: 1,
  show: 2,
  season: 3,
  episode: 4,
  trailer: 5,
  artist: 8,
  album: 9,
  track: 10,
  clip: 12,
  photo: 13,
  photoAlbum: 14,
  playlist: 15,
  collection: 18,
} as const;

const TYPE_NAMES: Record<string, number> = {
  movie: 1,
  show: 2,
  season: 3,
  episode: 4,
  trailer: 5,
  artist: 8,
  album: 9,
  track: 10,
  clip: 12,
  photo: 13,
  photoalbum: 14,
  photo_album: 14,
};

export type PlayQueueType = "video" | "audio" | "photo";

export interface SortSpec {
  field: string;
  /** Direction and modifiers, e.g. ["desc"] or ["desc", "nullsLast"]. */
  modifiers: string[];
}

export interface ServerRef {
  /** Base URL of PMS as the browser reaches it, e.g. "https://host:32400". */
  baseUrl: string;
  machineIdentifier: string;
}

export interface ListingRef {
  /** Section of a library grid listing (/library/sections/<id>/all). */
  sectionId?: string | number;
  /**
   * Any other listed container, e.g. a season's episodes:
   * "/library/metadata/<id>/children". Takes precedence over sectionId.
   */
  containerPath?: string;
  /** Query of the visible listing (sort, type, filters). Paging/client params are dropped. */
  params: URLSearchParams | Record<string, string> | string;
  /** Needed only for the library:// URI scheme. */
  librarySectionUUID?: string;
}

export interface ItemRef {
  ratingKey: string | number;
  /** Plex metadata type (number or name). Used when the listing has no `type`. */
  type?: number | string;
}

export interface CreatePlayQueueOptions {
  server: ServerRef;
  listing: ListingRef;
  item: ItemRef;
  /** Content URI scheme. Default "server". */
  scheme?: "server" | "library";
  /** Headers to send (X-Plex-Token, X-Plex-Client-Identifier, ...). */
  headers?: Record<string, string>;
  repeat?: 0 | 1 | 2;
  /** Extra query params for POST /playQueues (e.g. includeChapters=1). */
  extraParams?: Record<string, string>;
  /** Listing params to drop in addition to the defaults (see DROPPED_LISTING_PARAMS). */
  dropParams?: readonly string[];
}

export interface HttpRequest {
  method: "GET" | "POST" | "PUT";
  url: string;
  headers: Record<string, string>;
}

const SORT_ITEM = /^[A-Za-z][\w.]*(?::[A-Za-z]+)*$/;

/** Parses `field[:dir[:modifier]]` (comma-separated for multi-key sorts). */
export function parseSort(sort: string): SortSpec[] {
  const parts = sort
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) throw new Error("empty sort");
  return parts.map((p) => {
    if (!SORT_ITEM.test(p)) throw new Error(`invalid sort component "${p}"`);
    const [field, ...modifiers] = p.split(":");
    return { field: field!, modifiers };
  });
}

export function formatSort(specs: readonly SortSpec[]): string {
  return specs.map((s) => [s.field, ...s.modifiers].join(":")).join(",");
}

/**
 * Listing params that only affect paging or response shape, never which items
 * are listed or in what order. `X-Plex-*` (tokens, client info) is always dropped.
 */
export const DROPPED_LISTING_PARAMS: readonly string[] = [
  "includeMeta",
  "includeAdvanced",
  "includeGuids",
  "includeExternalMedia",
  "includeDetails",
  "includeFields",
  "includeElements",
  "excludeFields",
  "excludeElements",
  "checkFiles",
  "asyncCheckFiles",
];

function toParams(p: ListingRef["params"]): URLSearchParams {
  if (p instanceof URLSearchParams) return new URLSearchParams(p);
  if (typeof p === "string") return new URLSearchParams(p.startsWith("?") ? p.slice(1) : p);
  return new URLSearchParams(p);
}

/**
 * Keeps the params that define the visible list (type, sort, filters, and
 * filter grouping such as push/pop/or), in their original order. Validates
 * `sort` and normalizes its formatting.
 */
export function sanitizeListingParams(params: ListingRef["params"], extraDrops: readonly string[] = []): URLSearchParams {
  const drop = new Set([...DROPPED_LISTING_PARAMS, ...extraDrops].map((k) => k.toLowerCase()));
  const out = new URLSearchParams();
  for (const [k, v] of toParams(params)) {
    if (/^x-plex-/i.test(k) || drop.has(k.toLowerCase())) continue;
    if (k === "sort") {
      out.append(k, formatSort(parseSort(v)));
      continue;
    }
    out.append(k, v);
  }
  return out;
}

function assertSectionId(id: string | number): string {
  const s = String(id);
  if (!/^\d+$/.test(s)) throw new Error(`invalid library section id "${s}"`);
  return s;
}

function assertRatingKey(key: string | number): string {
  const s = String(key);
  if (!/^\d+$/.test(s)) throw new Error(`invalid ratingKey "${s}"`);
  return s;
}

function assertSafeSegment(name: string, v: string): string {
  if (!v || !/^[A-Za-z0-9._-]+$/.test(v)) throw new Error(`invalid ${name} "${v}"`);
  return v;
}

/**
 * Serializes query params with percent-encoding. `readable` keeps `:` and `,`
 * literal (as in `sort=year:desc,titleSort`), which is how Plex Web itself
 * writes listing paths; everything else is encoded.
 */
export function serializeQuery(params: URLSearchParams, readable = false): string {
  const enc = (s: string) => {
    const e = encodeURIComponent(s);
    return readable ? e.replace(/%3A/gi, ":").replace(/%2C/gi, ",") : e;
  };
  return [...params].map(([k, v]) => `${enc(k)}=${enc(v)}`).join("&");
}

/** `/library/sections/<id>/all?<sanitized params>` */
export function buildSectionPath(sectionId: string | number, params: ListingRef["params"], extraDrops: readonly string[] = []): string {
  const q = serializeQuery(sanitizeListingParams(params, extraDrops), true);
  return `/library/sections/${assertSectionId(sectionId)}/all${q ? `?${q}` : ""}`;
}

/** Listed containers we know how to turn into a play queue source. */
export const CONTAINER_PATH = /^\/library\/(?:sections\/\d+\/all|metadata\/\d+\/children)$/;

/** The listing as a container path with its sanitized query (the play queue's source path). */
export function buildContainerPath(listing: ListingRef, extraDrops: readonly string[] = []): string {
  if (listing.containerPath === undefined) {
    if (listing.sectionId === undefined) throw new Error("listing needs a sectionId or a containerPath");
    return buildSectionPath(listing.sectionId, listing.params, extraDrops);
  }
  if (!CONTAINER_PATH.test(listing.containerPath)) throw new Error(`unsupported container path "${listing.containerPath}"`);
  const q = serializeQuery(sanitizeListingParams(listing.params, extraDrops), true);
  return `${listing.containerPath}${q ? `?${q}` : ""}`;
}

/** `/library/metadata/<ratingKey>` */
export function metadataKey(ratingKey: string | number): string {
  return `/library/metadata/${assertRatingKey(ratingKey)}`;
}

/** The play queue's source URI for a sorted/filtered section listing. */
export function buildListingUri(
  server: Pick<ServerRef, "machineIdentifier">,
  listing: ListingRef,
  scheme: "server" | "library" = "server",
  extraDrops: readonly string[] = [],
): string {
  const path = buildContainerPath(listing, extraDrops);
  if (scheme === "library") {
    const uuid = assertSafeSegment("librarySectionUUID", listing.librarySectionUUID ?? "");
    return `library://${uuid}/directory/${encodeURIComponent(path)}`;
  }
  return `server://${assertSafeSegment("machineIdentifier", server.machineIdentifier)}/com.plexapp.plugins.library${path}`;
}

export function typeNumber(t: number | string | undefined | null): number | undefined {
  if (t === undefined || t === null || t === "") return undefined;
  if (typeof t === "number") return t;
  if (/^\d+$/.test(t)) return Number(t);
  return TYPE_NAMES[t.toLowerCase()];
}

/** Which kind of play queue a listing/item type produces. */
export function playQueueTypeFor(t: number | string | undefined): PlayQueueType {
  const n = typeNumber(t);
  switch (n) {
    case PlexType.artist:
    case PlexType.album:
    case PlexType.track:
      return "audio";
    case PlexType.photo:
    case PlexType.photoAlbum:
      return "photo";
    case undefined:
    case PlexType.movie:
    case PlexType.show:
    case PlexType.season:
    case PlexType.episode:
    case PlexType.trailer:
    case PlexType.clip:
      return "video";
    default:
      throw new Error(`unsupported Plex type ${String(t)} for a play queue`);
  }
}

export function normalizeBaseUrl(baseUrl: string): string {
  const u = new URL(baseUrl);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`unsupported base URL protocol ${u.protocol}`);
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

/** The POST /playQueues request that starts at `item` and follows the visible order. */
export function buildCreatePlayQueueRequest(opts: CreatePlayQueueOptions): HttpRequest {
  const listingType = sanitizeListingParams(opts.listing.params, opts.dropParams).get("type") ?? undefined;
  const q = new URLSearchParams();
  q.set("type", playQueueTypeFor(listingType ?? opts.item.type));
  q.set("uri", buildListingUri(opts.server, opts.listing, opts.scheme ?? "server", opts.dropParams));
  q.set("key", metadataKey(opts.item.ratingKey));
  q.set("shuffle", "0");
  q.set("repeat", String(opts.repeat ?? 0));
  for (const [k, v] of Object.entries(opts.extraParams ?? {})) {
    if (/^x-plex-token$/i.test(k)) throw new Error("pass the token as a header, not a query param");
    q.set(k, v);
  }
  return {
    method: "POST",
    url: `${normalizeBaseUrl(opts.server.baseUrl)}/playQueues?${serializeQuery(q)}`,
    headers: { Accept: "application/json", ...(opts.headers ?? {}) },
  };
}

/** GET /playQueues/<id> (used by e2e to read back the queue order). */
export function buildGetPlayQueueRequest(
  baseUrl: string,
  playQueueId: string | number,
  opts: { window?: number; own?: boolean; headers?: Record<string, string> } = {},
): HttpRequest {
  const q = new URLSearchParams();
  if (opts.window !== undefined) q.set("window", String(opts.window));
  if (opts.own) q.set("own", "1");
  const qs = serializeQuery(q);
  return {
    method: "GET",
    url: `${normalizeBaseUrl(baseUrl)}/playQueues/${assertRatingKey(playQueueId)}${qs ? `?${qs}` : ""}`,
    headers: { Accept: "application/json", ...(opts.headers ?? {}) },
  };
}

export interface CreatedPlayQueue {
  id: string;
  selectedItemId?: string;
  selectedItemOffset?: number;
  selectedRatingKey?: string;
  totalCount?: number;
  version?: number;
  /** Items in queue order (the window PMS returned). */
  items: Array<{ ratingKey: string; playQueueItemID?: string; type?: string }>;
}

/** Parses a PMS JSON play queue response (POST or GET /playQueues). */
export function parsePlayQueue(json: unknown): CreatedPlayQueue {
  const mc = (json as any)?.MediaContainer;
  if (!mc || mc.playQueueID === undefined) throw new Error("response is not a play queue (no MediaContainer.playQueueID)");
  const str = (v: unknown) => (v === undefined || v === null ? undefined : String(v));
  const num = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : Number(v));
  const out: CreatedPlayQueue = {
    id: String(mc.playQueueID),
    items: (Array.isArray(mc.Metadata) ? mc.Metadata : []).map((m: any) => ({
      ratingKey: String(m.ratingKey),
      ...(m.playQueueItemID !== undefined ? { playQueueItemID: String(m.playQueueItemID) } : {}),
      ...(m.type !== undefined ? { type: String(m.type) } : {}),
    })),
  };
  const sel = str(mc.playQueueSelectedItemID);
  if (sel !== undefined) out.selectedItemId = sel;
  const off = num(mc.playQueueSelectedItemOffset);
  if (off !== undefined) out.selectedItemOffset = off;
  const selKey = str(mc.playQueueSelectedMetadataItemID);
  if (selKey !== undefined) out.selectedRatingKey = selKey;
  const total = num(mc.playQueueTotalCount);
  if (total !== undefined) out.totalCount = total;
  const ver = num(mc.playQueueVersion);
  if (ver !== undefined) out.version = ver;
  return out;
}

/** Rating keys from the selected item onward, in queue order. */
export function itemsFromSelected(queue: CreatedPlayQueue): string[] {
  let start = queue.items.findIndex((i) => i.playQueueItemID !== undefined && i.playQueueItemID === queue.selectedItemId);
  if (start < 0 && queue.selectedRatingKey) start = queue.items.findIndex((i) => i.ratingKey === queue.selectedRatingKey);
  if (start < 0) start = 0;
  return queue.items.slice(start).map((i) => i.ratingKey);
}

export interface ObservedListing {
  /** PMS base URL (origin plus any reverse-proxy path prefix). */
  baseUrl: string;
  /** "/library/sections/<id>/all" or "/library/metadata/<id>/children". */
  containerPath: string;
  /** Set for section listings. */
  sectionId?: string;
  /** Set for children listings: the parent's rating key. */
  parentRatingKey?: string;
  /** Full query of the request, unsanitized (sanitize at use). */
  params: URLSearchParams;
}

/**
 * Params that mark a section request as a background query of Plex Web
 * (e.g. its "recently added" hubs) rather than the visible listing.
 */
export const BACKGROUND_LISTING_PARAMS: readonly string[] = ["contentDirectoryID", "pinnedContentDirectoryID"]; // = plex-anchors api.backgroundListingParams

/**
 * Recognizes the listing requests Plex Web makes for what is on screen:
 *   /library/sections/<id>/all?type=1&sort=year:desc&...   (library grid/list)
 *   /library/metadata/<id>/children?...                     (e.g. a season's episodes)
 * Returns null for anything else (hubs, metadata, background queries).
 */
export function parseListingRequest(url: string, base?: string): ObservedListing | null {
  let u: URL;
  try {
    u = new URL(url, base);
  } catch {
    return null;
  }
  const params = new URLSearchParams(u.search);
  const sec = /^(.*?)(\/library\/sections\/(\d+)\/all)\/?$/.exec(u.pathname);
  if (sec) {
    if (BACKGROUND_LISTING_PARAMS.some((k) => params.has(k))) return null;
    return { baseUrl: `${u.origin}${sec[1]}`, containerPath: sec[2]!, sectionId: sec[3]!, params };
  }
  const kids = /^(.*?)(\/library\/metadata\/(\d+)\/children)\/?$/.exec(u.pathname);
  if (kids) return { baseUrl: `${u.origin}${kids[1]}`, containerPath: kids[2]!, parentRatingKey: kids[3]!, params };
  return null;
}

/** `X-Plex-*` client values from a request's query and headers (headers win). */
export function extractPlexClientHeaders(url: string, headers: Record<string, string> = {}, base?: string): Record<string, string> {
  const out: Record<string, string> = {};
  const keep = (k: string) => /^x-plex-/i.test(k) && !/^x-plex-container-(start|size)$/i.test(k);
  try {
    for (const [k, v] of new URL(url, base).searchParams) if (keep(k)) out[canonicalHeader(k)] = v;
  } catch {
    /* ignore */
  }
  for (const [k, v] of Object.entries(headers)) if (keep(k)) out[canonicalHeader(k)] = v;
  return out;
}

function canonicalHeader(k: string): string {
  return k
    .split("-")
    .map((p) => (p.toLowerCase() === "x" ? "X" : p.charAt(0).toUpperCase() + p.slice(1)))
    .join("-");
}
