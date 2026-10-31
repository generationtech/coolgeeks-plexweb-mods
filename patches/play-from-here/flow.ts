/**
 * The "Play from here" flow, independent of how Plex Web is wired:
 *   visible listing + clicked item -> POST /playQueues -> native player.
 */
import type { PlaybackPath, PlexBindings } from "./bindings";
import { buildCreatePlayQueueRequest, parsePlayQueue, type CreatedPlayQueue, type ItemRef, type PlayQueueType } from "./playqueue";

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

  const req = buildCreatePlayQueueRequest({
    server,
    listing: {
      sectionId: listing.sectionId,
      params: listing.params,
      ...(listing.librarySectionUUID ? { librarySectionUUID: listing.librarySectionUUID } : {}),
    },
    item,
    headers: server.headers,
    ...(deps.requestOptions?.scheme ? { scheme: deps.requestOptions.scheme } : {}),
    ...(deps.requestOptions?.dropParams ? { dropParams: deps.requestOptions.dropParams } : {}),
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
    const playQueueType = (new URL(req.url).searchParams.get("type") ?? "video") as PlayQueueType;
    const playback = await deps.bindings.startPlayback({ queue, server, item, playQueueType });
    return { queue, playback };
  } catch (err) {
    throw new PlayFromHereError("playback", (err as Error).message, { cause: err });
  }
}
