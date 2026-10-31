/**
 * Default PlexBindings: learns the visible listing from observed network
 * requests, the server's machine identifier from GET /identity (cached), and
 * starts playback through the chosen path (see playback.ts).
 */
import { BindingUnavailableError, type ListingContext, type PlexBindings, type ServerContext } from "./bindings";
import type { ListingTracker } from "./network-observer";
import { choosePath, startPlayback, type PlaybackDeps } from "./playback";
import { normalizeBaseUrl } from "./playqueue";
import { PLEX_ANCHORS } from "./plex-anchors";

export interface RouteInfo {
  /** A page that lists items we can play from: a library grid, or a details page (e.g. a season). */
  isListing: boolean;
  kind: "section" | "details" | "other";
  machineIdentifier?: string;
  sectionId?: string;
  /** details pages: the item whose children are listed. */
  parentRatingKey?: string;
}

export function parseRoute(hash: string): RouteInfo {
  const listing = PLEX_ANCHORS.routes.libraryListing.value.exec(hash);
  if (listing) return { isListing: true, kind: "section", machineIdentifier: listing[1]!, sectionId: listing[2]! };
  const details = PLEX_ANCHORS.routes.detailsPage.value.exec(hash);
  if (details) return { isListing: true, kind: "details", machineIdentifier: details[1]!, parentRatingKey: details[2]! };
  const scoped = PLEX_ANCHORS.routes.serverScoped.value.exec(hash);
  return scoped ? { isListing: false, kind: "other", machineIdentifier: scoped[1]! } : { isListing: false, kind: "other" };
}

export interface DefaultBindingsDeps {
  location: { hash: string };
  tracker: ListingTracker;
  fetch: (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  playback: PlaybackDeps;
}

export function createDefaultBindings(deps: DefaultBindingsDeps): PlexBindings {
  const identities = new Map<string, Promise<string>>();

  const identify = (baseUrl: string, headers: Record<string, string>): Promise<string> => {
    const key = normalizeBaseUrl(baseUrl);
    let p = identities.get(key);
    if (!p) {
      p = deps
        .fetch(`${key}${PLEX_ANCHORS.api.identity.value}`, { method: "GET", headers: { Accept: "application/json", ...headers } })
        .then(async (res) => {
          if (!res.ok) throw new Error(`GET /identity: HTTP ${res.status}`);
          const id = (await res.json() as any)?.MediaContainer?.machineIdentifier;
          if (!id) throw new Error("GET /identity: no machineIdentifier");
          return String(id);
        });
      p.catch(() => identities.delete(key));
      identities.set(key, p);
    }
    return p;
  };

  return {
    currentListing(): ListingContext | null {
      const route = parseRoute(deps.location.hash);
      if (route.kind === "section") return deps.tracker.current({ sectionId: route.sectionId! });
      if (route.kind === "details") return deps.tracker.current({ parentRatingKey: route.parentRatingKey! });
      return deps.tracker.current();
    },
    async serverFor(listing: ListingContext): Promise<ServerContext> {
      const headers = deps.tracker.headersFor(listing.baseUrl);
      let machineIdentifier: string;
      try {
        machineIdentifier = await identify(listing.baseUrl, headers);
      } catch (err) {
        const route = parseRoute(deps.location.hash);
        if (!route.machineIdentifier) {
          throw new BindingUnavailableError(`cannot determine the server's machine identifier: ${(err as Error).message}`);
        }
        machineIdentifier = route.machineIdentifier;
      }
      return { baseUrl: listing.baseUrl, machineIdentifier, headers };
    },
    async itemType(server: ServerContext, ratingKey: string): Promise<string | undefined> {
      const res = await deps.fetch(`${normalizeBaseUrl(server.baseUrl)}/library/metadata/${encodeURIComponent(ratingKey)}`, {
        method: "GET",
        headers: { Accept: "application/json", ...server.headers },
      });
      if (!res.ok) return undefined;
      return ((await res.json()) as any)?.MediaContainer?.Metadata?.[0]?.type;
    },
    playbackPath: () => choosePath(deps.playback),
    startPlayback: (req) => startPlayback(deps.playback, req),
  };
}
