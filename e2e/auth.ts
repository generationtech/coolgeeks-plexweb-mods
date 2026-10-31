/**
 * Token auth injected into storage before Plex Web boots. Never a stored
 * login (no storageState files). The storage keys are Plex Web internals
 * and UNVERIFIED (BACKLOG B4): adjust here once confirmed.
 */
import type { BrowserContext } from "@playwright/test";

export const TOKEN_STORAGE_KEYS = ["myPlexAccessToken"] as const;

export async function injectTokenAuth(context: BrowserContext, token: string): Promise<void> {
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
