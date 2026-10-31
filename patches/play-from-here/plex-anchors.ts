/**
 * EVERY Plex-coupled assumption of "Play from here" lives in this file.
 *
 * Swap values here (and only here) when research against a real Plex Web
 * bundle or a live server confirms or corrects them. Each entry carries a
 * status:
 *   - "documented": public PMS API surface, community-documented, stable.
 *   - "unverified": a candidate that still has to be proven against a real
 *                   bundle/server (see BACKLOG.md and docs/anchor-research.md).
 *   - "verified":   proven by preflight or e2e; note the Plex Web version.
 *
 * Only short anchor strings belong here (a few words, localization keys, API
 * paths). Never paste Plex code.
 */

export type AnchorStatus = "documented" | "unverified" | "verified";

export interface Anchor<T> {
  readonly value: T;
  readonly status: AnchorStatus;
  /** Where the value comes from / how to verify it. */
  readonly source: string;
}

const a = <T>(value: T, status: AnchorStatus, source: string): Anchor<T> => ({ value, status, source });

export const PLEX_ANCHORS = {
  /** Strings inside Plex Web's webpack modules (consumed by the patch engine). */
  bundle: {
    /**
     * Module that defines the item context-menu entries. Located for
     * diagnostics/future bundle-level menu patching; the shipped UI path is
     * the DOM integration below.
     */
    contextMenuModule: a(
      ["Play Next", "Add to Up Next"] as const,
      "unverified",
      "Visible menu labels in Plex Web; whether they appear verbatim in the same module is unknown (BACKLOG: preflight).",
    ),
    /**
     * Module that starts Plex Web's own player for a play queue. Candidate
     * strings: PMS play-queue response fields any such module must read.
     */
    nativePlayerModule: a(
      ["playQueueSelectedItemID", "/playQueues"] as const,
      "unverified",
      "PMS play queue API field/path names; likely matches several modules until narrowed with a player-specific string.",
    ),
  },

  /** DOM structure of Plex Web (consumed by dom-menu.ts). */
  dom: {
    menuSelector: a('[role="menu"]', "unverified", "ARIA role used by most React menu libraries."),
    menuItemSelector: a('[role="menuitem"]', "unverified", "ARIA role of menu entries."),
    /** Labels of the existing entry after which "Play from here" is inserted (first match wins). */
    menuAnchorLabels: a(["Play Next", "Add to Up Next"] as const, "unverified", "Visible English labels; localized UIs need their translations."),
    /** Links on poster cards/rows that identify the item. */
    itemLinkSelector: a('a[href*="%2Flibrary%2Fmetadata%2F"]', "unverified", "Plex Web detail links carry key=/library/metadata/<ratingKey> URL-encoded."),
    itemKeyPattern: a(/key=%2Flibrary%2Fmetadata%2F(\d+)/, "unverified", "As above."),
  },

  /** Plex Web hash routes (consumed by bindings.ts). */
  routes: {
    /** Library listing route; captures [machineIdentifier, sectionId]. */
    libraryListing: a(
      /#!\/media\/([^/?#]+)\/com\.plexapp\.plugins\.library\?(?:[^#]*&)?source=(\d+)/,
      "unverified",
      "Observed shape of Plex Web library URLs; confirm on the local server.",
    ),
    /** Any server-scoped route; captures [machineIdentifier]. */
    serverScoped: a(/#!\/(?:media|server)\/([0-9a-zA-Z-]+)\//, "unverified", "As above."),
  },

  /** PMS HTTP API (stable, community-documented). */
  api: {
    sectionListingPath: a("/library/sections/<id>/all", "documented", "PMS library listing endpoint."),
    playQueues: a("/playQueues", "documented", "PMS play queue endpoint (POST create, GET read)."),
    identity: a("/identity", "documented", "Unauthenticated endpoint returning machineIdentifier."),
    companionPlayMedia: a(
      "/player/playback/playMedia",
      "unverified",
      "Plex remote-control (companion) command, proxied by PMS to a client via X-Plex-Target-Client-Identifier; works only if Plex Web advertises as a player.",
    ),
  },
} as const;

/** Flattened list for reports and docs. */
export function listAnchors(): Array<{ path: string; status: AnchorStatus; value: string; source: string }> {
  const out: Array<{ path: string; status: AnchorStatus; value: string; source: string }> = [];
  for (const [group, entries] of Object.entries(PLEX_ANCHORS)) {
    for (const [name, anchor] of Object.entries(entries as Record<string, Anchor<unknown>>)) {
      const v = anchor.value;
      out.push({ path: `${group}.${name}`, status: anchor.status, value: Array.isArray(v) ? v.join(" + ") : String(v), source: anchor.source });
    }
  }
  return out;
}
