/**
 * EVERY Plex-coupled assumption of "Play from here" lives in this file.
 *
 * Swap values here (and only here) when Plex Web changes. Each entry carries
 * a status:
 *   - "documented": public PMS API surface, community-documented, stable.
 *   - "unverified": a candidate that still has to be proven.
 *   - "verified":   proven by preflight and/or a live run; `source` names the
 *                   Plex Web version and how it was checked.
 *
 * Only short anchor strings belong here (a few words, localization keys, API
 * paths, attribute names). Never paste Plex code.
 */

export type AnchorStatus = "documented" | "unverified" | "verified";

export interface Anchor<T> {
  readonly value: T;
  readonly status: AnchorStatus;
  /** Where the value comes from / how it was verified. */
  readonly source: string;
}

const a = <T>(value: T, status: AnchorStatus, source: string): Anchor<T> => ({ value, status, source });

/** Plex Web build the "verified" entries were checked against. */
export const VERIFIED_AGAINST = "Plex Web 4.162.1 (PMS 1.43.5.11079)";

export const PLEX_ANCHORS = {
  /** Strings inside Plex Web's webpack modules (consumed by the patch engine). */
  bundle: {
    /**
     * Action type that starts playback of an existing play queue. Selects
     * exactly one module, whose exports include the handler map keyed by it.
     */
    startExistingPlayQueueAction: a(
      "ui/player/playerLifecycle/startExistingPlayQueuePlayback",
      "verified",
      `${VERIFIED_AGAINST}: preflight locates exactly 1 module; live run started playback through it.`,
    ),
    /**
     * Fallback: action type that queues playback; with options.playQueueID it
     * fetches that existing queue and starts it. Same module and handler map
     * as the primary action. (The "startPlayback" action was rejected: it only
     * builds directory+key queues for tracks, photos and clips.)
     */
    queuePlaybackAction: a(
      "ui/player/playerLifecycle/queuePlayback",
      "unverified",
      `${VERIFIED_AGAINST}: preflight locates exactly 1 module; to be proven by a forced live run.`,
    ),
    /** Fallback: actions used to clear an open player first (else queuePlayback appends to its queue). */
    endPlaybackAction: a("ui/player/playerLifecycle/endPlayback", "unverified", `${VERIFIED_AGAINST}: same handler map.`),
    resetPlayerAction: a("ui/player/playerControls/resetAndClosePlayer", "unverified", `${VERIFIED_AGAINST}: same handler map.`),
    /** Service name of Plex Web's root model, looked up through its service registry. */
    appModelService: a('"appModel"', "verified", `${VERIFIED_AGAINST}: occurs once in the module selected above.`),
    /** Item context-menu labels (English source strings are also the localization keys). */
    contextMenuLabels: a(
      ["Play Next", "Add to Queue"] as const,
      "verified",
      `${VERIFIED_AGAINST}: both labels in the same 6 modules; "Add to Up Next" no longer exists.`,
    ),
  },

  /** Plex Web runtime model API used by the native-player adapter. */
  appApi: {
    serversAttr: a("servers", "verified", `${VERIFIED_AGAINST}: appModel attribute holding the server collection; live run.`),
    populateServer: a("populateServer", "verified", `${VERIFIED_AGAINST}: server collection method (machine identifier -> server model); live run.`),
    providersAttr: a("providers", "verified", `${VERIFIED_AGAINST}: server attribute holding the provider collection; live run.`),
    populate: a("populate", "verified", `${VERIFIED_AGAINST}: async loader on collections/models; live run.`),
    libraryProviderIdentifier: a("com.plexapp.plugins.library", "verified", `${VERIFIED_AGAINST}: library provider identifier constant.`),
    /** Fallback path: where the open player lives (appModel.get(ui).get(<type>Player).get(playQueue)). */
    uiAttr: a("ui", "unverified", `${VERIFIED_AGAINST}: appModel attribute holding UI models.`),
    playerModels: a({ video: "audioVideoPlayer", audio: "audioVideoPlayer", photo: "photoPlayer" } as const, "unverified", `${VERIFIED_AGAINST}: player model names per play queue type.`),
    playerQueueAttr: a("playQueue", "unverified", `${VERIFIED_AGAINST}: player model attribute holding the open queue.`),
  },

  /** DOM structure of Plex Web (consumed by dom-menu.ts). */
  dom: {
    /** Menu entries. The menu container has no role; the anchor entry's parent is used. */
    menuItemSelector: a('[role="menuitem"]', "verified", `${VERIFIED_AGAINST}: menu entries are role=menuitem (testid dropdownItem); live DOM.`),
    /** Entry after which "Play from here" is inserted (first match wins). */
    menuAnchorLabels: a(["Play Next", "Add to Queue"] as const, "verified", `${VERIFIED_AGAINST}: English UI; other languages use their translations.`),
    /** Links on poster cards/rows that identify the item. */
    itemLinkSelector: a('a[href*="%2Flibrary%2Fmetadata%2F"]', "verified", `${VERIFIED_AGAINST}: two links per card (poster, title), same key; live DOM.`),
    itemKeyPattern: a(/key=%2Flibrary%2Fmetadata%2F(\d+)/, "verified", `${VERIFIED_AGAINST}: #!/server/<id>/details?key=... links; live DOM.`),
  },

  /** Plex Web hash routes (consumed by default-bindings.ts). */
  routes: {
    /** Library grid ("Library" tab) of a section; captures [machineIdentifier, sectionId]. */
    libraryListing: a(
      /#!\/media\/([^/?#]+)\/com\.plexapp\.plugins\.library\?(?=[^#]*\bpivot=library\b)(?:[^#]*&)?source=(\d+)/,
      "verified",
      `${VERIFIED_AGAINST}: route /media/:machineIdentifier?/:providerIdentifier with source=<section> and pivot=library; live run.`,
    ),
    /** Item details page (e.g. a season listing its episodes); captures [machineIdentifier, ratingKey]. */
    detailsPage: a(
      /#!\/server\/([^/?#]+)\/details\?(?:[^#]*&)?key=%2Flibrary%2Fmetadata%2F(\d+)(?:[&#]|$)/,
      "verified",
      `${VERIFIED_AGAINST}: season pages are /server/:machineIdentifier/details?key=<encoded /library/metadata/id>; live run.`,
    ),
    /** Any server-scoped route; captures [machineIdentifier]. */
    serverScoped: a(/#!\/(?:media|server)\/([0-9a-zA-Z-]+)\//, "verified", `${VERIFIED_AGAINST}: /media/... and /server/:machineIdentifier/... routes.`),
  },

  /** PMS HTTP API. */
  api: {
    sectionListingPath: a("/library/sections/<id>/all", "verified", "PMS 1.43.5: Plex Web's grid requests it with type, sort and filters; live run."),
    childrenListingPath: a("/library/metadata/<id>/children", "verified", "PMS 1.43.5: Plex Web's season page lists episodes with it; live run."),
    /** Params of Plex Web's background section queries (recently-added hubs), never the visible listing. */
    backgroundListingParams: a(["contentDirectoryID", "pinnedContentDirectoryID"] as const, "verified", `${VERIFIED_AGAINST}: seen on /library/sections/<id>/all requests for hubs; live run.`),
    playQueues: a("/playQueues", "verified", "PMS 1.43.5: POST with a sorted section uri + key returns the visible order from key on; curl and live run."),
    identity: a("/identity", "verified", "PMS 1.43.5: unauthenticated, returns machineIdentifier."),
    companionPlayMedia: a(
      "/player/playback/playMedia",
      "unverified",
      "Fallback only (used when the native player is unavailable); not exercised.",
    ),
  },
} as const;

/** Flattened list for reports and docs. */
export function listAnchors(): Array<{ path: string; status: AnchorStatus; value: string; source: string }> {
  const out: Array<{ path: string; status: AnchorStatus; value: string; source: string }> = [];
  for (const [group, entries] of Object.entries(PLEX_ANCHORS)) {
    for (const [name, anchor] of Object.entries(entries as Record<string, Anchor<unknown>>)) {
      const v = anchor.value;
      const value = Array.isArray(v) ? v.join(" + ") : v && typeof v === "object" && !(v instanceof RegExp) ? JSON.stringify(v) : String(v);
      out.push({ path: `${group}.${name}`, status: anchor.status, value, source: anchor.source });
    }
  }
  return out;
}
