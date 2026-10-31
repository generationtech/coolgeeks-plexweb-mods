/**
 * Choosing and running a playback path (see PlaybackPath in bindings.ts):
 *   native -> native-fallback -> companion (auto), or forced with the
 *   runtime option pfh-player=primary|fallback|companion.
 */
import { BindingUnavailableError, type NativePlayer, type PlaybackPath, type PlaybackRequest } from "./bindings";
import { metadataKey, normalizeBaseUrl, playQueueTypeFor, serializeQuery, type HttpRequest } from "./playqueue";

export type PlayerPreference = "auto" | "primary" | "fallback" | "companion";

export function parsePlayerPreference(v: string | undefined): PlayerPreference {
  return v === "primary" || v === "fallback" || v === "companion" ? v : "auto";
}

export interface CompanionOptions {
  /** Plex Web's X-Plex-Client-Identifier (the player to target). */
  targetClientIdentifier: string;
  commandId: number;
  itemType?: number | string;
}

/** GET /player/playback/playMedia proxied by PMS to the target client. */
export function buildCompanionPlayMediaRequest(req: PlaybackRequest, opts: CompanionOptions): HttpRequest {
  const base = new URL(normalizeBaseUrl(req.server.baseUrl));
  const q = new URLSearchParams();
  q.set("type", opts.itemType !== undefined ? playQueueTypeFor(opts.itemType) : req.playQueueType);
  q.set("providerIdentifier", "com.plexapp.plugins.library");
  q.set("containerKey", `/playQueues/${req.queue.id}?own=1&window=200`);
  q.set("key", metadataKey(req.queue.selectedRatingKey ?? req.item.ratingKey));
  q.set("offset", "0");
  q.set("machineIdentifier", req.server.machineIdentifier);
  q.set("protocol", base.protocol.replace(":", ""));
  q.set("address", base.hostname);
  q.set("port", base.port || (base.protocol === "https:" ? "443" : "80"));
  q.set("commandID", String(opts.commandId));
  return {
    method: "GET",
    url: `${normalizeBaseUrl(req.server.baseUrl)}/player/playback/playMedia?${serializeQuery(q)}`,
    headers: {
      Accept: "application/json",
      ...req.server.headers,
      "X-Plex-Target-Client-Identifier": opts.targetClientIdentifier,
    },
  };
}

export interface PlaybackDeps {
  nativePlayer(): NativePlayer | null;
  fallbackPlayer(): NativePlayer | null;
  preference: PlayerPreference;
  companionEnabled: boolean;
  fetch: (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>;
  nextCommandId(): number;
}

export function choosePath(deps: PlaybackDeps): { path: PlaybackPath | null; reason?: string } {
  const native = !!deps.nativePlayer();
  const fallback = !!deps.fallbackPlayer();
  switch (deps.preference) {
    case "primary":
      return native ? { path: "native" } : { path: null, reason: "pfh-player=primary, but the native player (play-from-here/native-player) is not resolved" };
    case "fallback":
      return fallback
        ? { path: "native-fallback" }
        : { path: null, reason: "pfh-player=fallback, but the fallback player (play-from-here/native-player-fallback) is not resolved" };
    case "companion":
      return deps.companionEnabled ? { path: "companion" } : { path: null, reason: "pfh-player=companion, but the companion fallback is disabled" };
    default:
      if (native) return { path: "native" };
      if (fallback) return { path: "native-fallback" };
      if (deps.companionEnabled) return { path: "companion" };
      return { path: null, reason: "neither native player path is resolved and the companion fallback is disabled" };
  }
}

export async function startPlayback(deps: PlaybackDeps, req: PlaybackRequest): Promise<PlaybackPath> {
  const { path, reason } = choosePath(deps);
  if (!path) throw new BindingUnavailableError(reason ?? "no playback path");
  if (path === "native") {
    await deps.nativePlayer()!.play(req);
    return path;
  }
  if (path === "native-fallback") {
    await deps.fallbackPlayer()!.play(req);
    return path;
  }
  const clientId = req.server.headers["X-Plex-Client-Identifier"];
  if (!clientId) throw new BindingUnavailableError("companion fallback: no X-Plex-Client-Identifier observed");
  const http = buildCompanionPlayMediaRequest(req, { targetClientIdentifier: clientId, commandId: deps.nextCommandId() });
  const res = await deps.fetch(http.url, { method: http.method, headers: http.headers });
  if (!res.ok) throw new BindingUnavailableError(`companion fallback failed with HTTP ${res.status} (is Plex Web set to advertise as a player?)`);
  return path;
}
