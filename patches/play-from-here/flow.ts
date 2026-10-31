/**
 * The "Play from here" flow, independent of how Plex Web is wired:
 *   visible listing + clicked item -> POST /playQueues -> native player.
 */
import type { PlaybackPath, PlexBindings } from "./bindings";
import {
  buildCreatePlayQueueRequest,
  parsePlayQueue,
  playQueueTypeFor,
  sanitizeListingParams,
  type CreatedPlayQueue,
  type ItemRef,
  type ListingRef,
  type PlayQueueType,
} from "./playqueue";

export interface FlowDeps {
  bindings: PlexBindings;
  fetch: (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  /** Options for the play queue request (e.g. scheme, dropParams). */
  requestOptions?: { scheme?: "server" | "library"; dropParams?: readonly string[] };
}

export interface FlowResult {
  queue: CreatedPlayQueue;
  playback: PlaybackPath;
}

export class PlayFromHereError extends Error {
  readonly step: "listing" | "server" | "create-queue" | "playback";
  constructor(step: PlayFromHereError["step"], message: string, options?: { cause?: unknown }) {
    super(`play-from-here [${step}]: ${message}`, options);
    this.name = "PlayFromHereError";
    this.step = step;
  }
}

export async function runPlayFromHere(deps: FlowDeps, item: ItemRef): Promise<FlowResult> {
  const listing = deps.bindings.currentListing();
  if (!listing) throw new PlayFromHereError("listing", "no library listing has been observed on this page yet");

  let server;
  try {
    server = await deps.bindings.serverFor(listing);
  } catch (err) {
    throw new PlayFromHereError("server", (err as Error).message, { cause: err });
  }

  const { path, reason } = deps.bindings.playbackPath();
  if (!path) throw new PlayFromHereError("playback", reason ?? "no playback path available");

  const listingRef: ListingRef = {
    containerPath: listing.containerPath,
    ...(listing.sectionId !== undefined ? { sectionId: listing.sectionId } : {}),
    params: listing.params,
    ...(listing.librarySectionUUID ? { librarySectionUUID: listing.librarySectionUUID } : {}),
  };
  const dropParams = deps.requestOptions?.dropParams ?? [];
  // The queue type follows the listing's type param; listings without one
  // (e.g. a season's children) ask the server for the item's type.
  let itemRef = item;
  if (!sanitizeListingParams(listing.params, dropParams).get("type") && item.type === undefined && deps.bindings.itemType) {
    const t = await deps.bindings.itemType(server, String(item.ratingKey)).catch(() => undefined);
    if (t) itemRef = { ...item, type: t };
  }
  const playQueueType = playQueueTypeFor(sanitizeListingParams(listing.params, dropParams).get("type") ?? itemRef.type) as PlayQueueType;

  const req = buildCreatePlayQueueRequest({
    server,
    listing: listingRef,
    item: itemRef,
    headers: server.headers,
    ...(deps.requestOptions?.scheme ? { scheme: deps.requestOptions.scheme } : {}),
    dropParams,
  });
  let queue: CreatedPlayQueue;
  try {
    const res = await deps.fetch(req.url, { method: req.method, headers: req.headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    queue = parsePlayQueue(await res.json());
  } catch (err) {
    throw new PlayFromHereError("create-queue", (err as Error).message, { cause: err });
  }

  try {
    const playback = await deps.bindings.startPlayback({ queue, server, item: itemRef, playQueueType });
    return { queue, playback };
  } catch (err) {
    throw new PlayFromHereError("playback", (err as Error).message, { cause: err });
  }
}
