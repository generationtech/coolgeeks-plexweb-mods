/** E2E configuration, from env vars only. */
export interface E2EEnv {
  url: string;
  /** Optional: an unclaimed server on an allowed network needs no token. */
  token: string | undefined;
  /** Movie (or any) library used by the basic tests. */
  sectionId: string;
  /** Optional libraries for the broader tests (each test skips when its id is unset). */
  tvSectionId: string | undefined;
  otherSectionId: string | undefined;
  bigSectionId: string | undefined;
  /** "route": inject the local dist/ build via request interception (server untouched). "server": expect reapply already ran. */
  inject: "route" | "server";
  /** Visible label of a non-default sort to pick in the UI (default "Year"). */
  sortLabel: string;
  /** Force a player path in route mode (pfh-player): auto | primary | fallback | companion. */
  player: string;
}

export const e2eEnabled = !!process.env.PLEX_URL;

export function e2eEnv(): E2EEnv {
  const missing = ["PLEX_URL", "PLEX_SECTION_ID"].filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`e2e needs ${missing.join(", ")} (see .env.example)`);
  const inject = process.env.PLEX_E2E_INJECT === "server" ? "server" : "route";
  return {
    url: process.env.PLEX_URL!.replace(/\/+$/, ""),
    token: process.env.PLEX_TOKEN || undefined,
    sectionId: process.env.PLEX_SECTION_ID!,
    tvSectionId: process.env.PLEX_E2E_TV_SECTION_ID || undefined,
    otherSectionId: process.env.PLEX_E2E_OTHER_SECTION_ID || undefined,
    bigSectionId: process.env.PLEX_E2E_BIG_SECTION_ID || undefined,
    inject,
    sortLabel: process.env.PLEX_E2E_SORT_LABEL || "Year",
    player: process.env.PLEX_E2E_PLAYER || "auto",
  };
}

/** The playback path the plugin should report for a forced preference. */
export function expectedPath(player: string): string {
  return player === "fallback" ? "native-fallback" : player === "companion" ? "companion" : "native";
}
