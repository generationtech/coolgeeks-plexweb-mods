/**
 * Token auth injected into storage before Plex Web boots. Never a stored
 * login (no storageState files). The storage keys are Plex Web internals
 * and UNVERIFIED (BACKLOG B3): the sandbox server was unclaimed and needed no
 * token, so this path has not run yet. Adjust here once confirmed.
 */
import type { BrowserContext } from "@playwright/test";

export const TOKEN_STORAGE_KEYS = ["myPlexAccessToken"] as const;

export async function injectTokenAuth(context: BrowserContext, token: string | undefined): Promise<void> {
  if (!token) return; // e.g. an unclaimed server on an allowed network
  await context.addInitScript(
    ({ keys, token }) => {
      try {
        for (const k of keys) window.localStorage.setItem(k, token);
      } catch {
        /* storage blocked */
      }
    },
    { keys: [...TOKEN_STORAGE_KEYS], token },
  );
}
