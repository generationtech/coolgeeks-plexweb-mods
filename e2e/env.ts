/** E2E configuration, from env vars only. */
export interface E2EEnv {
  url: string;
  token: string;
  sectionId: string;
  /** "route": inject the local dist/ build via request interception (server untouched). "server": expect reapply already ran. */
  inject: "route" | "server";
  /** Visible label of a non-default sort to pick in the UI (default "Year"). */
  sortLabel: string;
}

export const e2eEnabled = !!process.env.PLEX_URL;

export function e2eEnv(): E2EEnv {
  const missing = ["PLEX_URL", "PLEX_TOKEN", "PLEX_SECTION_ID"].filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`e2e needs ${missing.join(", ")} (see .env.example)`);
  const inject = process.env.PLEX_E2E_INJECT === "server" ? "server" : "route";
  return {
    url: process.env.PLEX_URL!.replace(/\/+$/, ""),
    token: process.env.PLEX_TOKEN!,
    sectionId: process.env.PLEX_SECTION_ID!,
    inject,
    sortLabel: process.env.PLEX_E2E_SORT_LABEL || "Year",
  };
}
