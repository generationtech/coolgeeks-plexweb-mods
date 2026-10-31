/**
 * The small interface between "Play from here" and Plex Web.
 *
 * Everything that depends on Plex Web internals (how we learn the visible
 * listing, which server we talk to, how the native player is started, how
 * the menu entry appears) sits behind these interfaces, so implementations
 * can be swapped for real bundle anchors without touching the core flow in
 * flow.ts or the pure request builder in playqueue.ts.
 */
import type { CreatedPlayQueue, ItemRef, PlayQueueType } from "./playqueue";

export interface ServerContext {
  /** PMS base URL as the browser reaches it. */
  baseUrl: string;
  machineIdentifier: string;
  /** Plex client headers to send (X-Plex-Token, X-Plex-Client-Identifier, ...). */
  headers: Record<string, string>;
}

export interface ListingContext {
  baseUrl: string;
  /** "/library/sections/<id>/all" or "/library/metadata/<id>/children". */
  containerPath: string;
  /** Section listings only. */
  sectionId?: string;
  /** Children listings only (e.g. the season whose episodes are listed). */
  parentRatingKey?: string;
  /** Query of the listing request Plex Web made (unsanitized). */
  params: URLSearchParams;
  /** When it was observed (ms epoch). */
  observedAt: number;
  librarySectionUUID?: string;
}

export interface PlaybackRequest {
  /** The queue we created (POST /playQueues). */
  queue: CreatedPlayQueue;
  /** "video" | "audio" | "photo", as sent in POST /playQueues. */
  playQueueType: PlayQueueType;
  server: ServerContext;
  item: ItemRef;
}

/**
 * - native:          Plex Web's "start existing play queue" action, on our queue.
 * - native-fallback: Plex Web's "queue playback" action, on our queue.
 * - companion:       remote-control playMedia proxied by PMS (last resort).
 */
export type PlaybackPath = "native" | "native-fallback" | "companion";

export interface PlexBindings {
  /** The listing currently on screen, or null when not on a library listing. */
  currentListing(): ListingContext | null;
  /** Server context (machine identifier, client headers) for a listing. */
  serverFor(listing: ListingContext): Promise<ServerContext>;
  /** Metadata type of an item (used when the listing does not say). */
  itemType?(server: ServerContext, ratingKey: string): Promise<string | undefined>;
  /** The path startPlayback will take right now, or null (with reason) when none is usable. */
  playbackPath(): { path: PlaybackPath | null; reason?: string };
  /** Start Plex Web's player on the created queue. */
  startPlayback(req: PlaybackRequest): Promise<PlaybackPath>;
}

/** How the "Play from here" entry is offered and how the clicked item is identified. */
export interface MenuIntegration {
  /** Installs the entry; returns an uninstall function. */
  install(handlers: { isAvailable(): boolean; onSelect(item: ItemRef): void }): () => void;
}

/**
 * Hook for Plex Web's own player. Registered by a bundle patch/capture once
 * the real entry point is known (see plex-anchors.ts: bundle.nativePlayerModule).
 */
export interface NativePlayer {
  play(req: PlaybackRequest): void | Promise<void>;
}

export class BindingUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BindingUnavailableError";
  }
}
