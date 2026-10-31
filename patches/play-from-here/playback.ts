/**
 * Starting playback of a created play queue in this browser.
 *
 * 1. native:    Plex Web's own player entry point, registered at runtime by a
 *               bundle patch/capture (see plex-anchors.ts). Preferred.
 * 2. companion: experimental fallback. Sends Plex's remote-control
 *               "playMedia" command through PMS to this very client
 *               (X-Plex-Target-Client-Identifier = Plex Web's own client id),
 *               which makes Plex Web's player start the queue. Requires Plex
 *               Web to advertise itself as a player. Unverified.
 */
import { BindingUnavailableError, type NativePlayer, type PlaybackPath, type PlaybackRequest } from "./bindings";
import { metadataKey, normalizeBaseUrl, playQueueTypeFor, serializeQuery, type HttpRequest } from "./playqueue";


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
  companionEnabled: boolean;
  fetch: (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>;
  nextCommandId(): number;
}

export async function startPlayback(deps: PlaybackDeps, req: PlaybackRequest): Promise<PlaybackPath> {
  const native = deps.nativePlayer();
  if (native) {
    await native.play(req);
    return "native";
  }
  if (!deps.companionEnabled) {
    throw new BindingUnavailableError(
      "native player entry point not resolved (patch play-from-here/native-player) and the companion fallback is disabled",
    );
  }
  const clientId = req.server.headers["X-Plex-Client-Identifier"];
  if (!clientId) {
    throw new BindingUnavailableError("native player not resolved, and no X-Plex-Client-Identifier observed for the companion fallback");
  }
  const http = buildCompanionPlayMediaRequest(req, { targetClientIdentifier: clientId, commandId: deps.nextCommandId() });
  const res = await deps.fetch(http.url, { method: http.method, headers: http.headers });
  if (!res.ok) {
    throw new BindingUnavailableError(
      `native player not resolved; companion fallback failed with HTTP ${res.status} (is Plex Web set to advertise as a player?)`,
    );
  }
  return "companion";
}
