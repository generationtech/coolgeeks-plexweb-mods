/**
 * Adapter to Plex Web's own player.
 *
 * Plex Web keeps its state in Backbone-style models (the root is the
 * "appModel" service) and handles actions with maps of
 *   actionType -> handler(appModel, payload, dispatch).
 * One of those actions starts playback of an already created play queue.
 * The patch for the module that defines it (anchor: the action type string)
 *   - captures the handler map from the module's exports (found by key, so
 *     minified export names do not matter), and
 *   - exposes the module's own appModel lookup via $self.
 * Everything here talks to those objects only through names listed in
 * plex-anchors.ts (appApi), so a Plex Web update means editing anchors, not code.
 */
import { BindingUnavailableError, type NativePlayer, type PlaybackRequest } from "./bindings";
import { PLEX_ANCHORS } from "./plex-anchors";

type Handler = (appModel: unknown, payload: Record<string, unknown>, dispatch?: unknown) => unknown;
type BackboneLike = { get(attr: string): any; entityID(): unknown };

export interface NativePlayerState {
  handlers: Record<string, unknown> | null;
  getAppModel: (() => unknown) | null;
}

/** Finds the action-handler map (an export object keyed by the action type). */
export function findHandlerMap(exports: unknown, actionType: string): Record<string, unknown> | null {
  if (!exports || (typeof exports !== "object" && typeof exports !== "function")) return null;
  for (const key of Object.keys(exports as object)) {
    let v: unknown;
    try {
      v = (exports as Record<string, unknown>)[key];
    } catch {
      continue;
    }
    if (v && typeof v === "object" && typeof (v as Record<string, unknown>)[actionType] === "function") {
      return v as Record<string, unknown>;
    }
  }
  return null;
}

const asPromise = <T>(v: T | PromiseLike<T>): Promise<T> => Promise.resolve(v);

/** Resolves Plex Web's server and library-provider models for a machine identifier. */
export async function resolveEntities(appModel: BackboneLike, machineIdentifier: string): Promise<{ serverEntityID: unknown; providerEntityID: unknown }> {
  const api = PLEX_ANCHORS.appApi;
  const servers = appModel.get(api.serversAttr.value);
  if (!servers || typeof servers[api.populateServer.value] !== "function") {
    throw new BindingUnavailableError(`appModel.get("${api.serversAttr.value}").${api.populateServer.value} is not available`);
  }
  const server: BackboneLike = await asPromise(servers[api.populateServer.value](machineIdentifier));
  if (!server) throw new BindingUnavailableError(`Plex Web does not know server ${machineIdentifier}`);
  const providers = await asPromise(server.get(api.providersAttr.value)[api.populate.value]());
  const provider = providers?.get?.(api.libraryProviderIdentifier.value);
  if (!provider) throw new BindingUnavailableError(`server has no ${api.libraryProviderIdentifier.value} provider`);
  const populated: BackboneLike = (await asPromise(provider[api.populate.value]())) ?? provider;
  return { serverEntityID: server.entityID(), providerEntityID: populated.entityID() };
}

export function createNativePlayer(state: NativePlayerState): NativePlayer {
  const actionType = PLEX_ANCHORS.bundle.startExistingPlayQueueAction.value;
  return {
    async play(req: PlaybackRequest) {
      const handler = state.handlers?.[actionType] as Handler | undefined;
      if (typeof handler !== "function") throw new BindingUnavailableError(`handler for ${actionType} not captured`);
      const appModel = state.getAppModel?.() as BackboneLike | undefined;
      if (!appModel || typeof appModel.get !== "function") throw new BindingUnavailableError("appModel not available");
      const ids = await resolveEntities(appModel, req.server.machineIdentifier);
      const id = /^\d+$/.test(req.queue.id) ? Number(req.queue.id) : req.queue.id;
      handler(appModel, {
        ...ids,
        playQueueType: req.playQueueType,
        playQueueID: id,
        playbackStartTime: Date.now(),
      });
    },
  };
}
