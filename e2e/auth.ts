/**
 * Token auth injected into storage before Plex Web boots. Never a stored
 * login (no storageState files). The storage keys are Plex Web internals;
 * keep them here.
 *
 * - TOKEN_STORAGE_KEYS: verified on Plex Web 4.160.0 against a claimed
 *   server (2026-11-01): Plex Web signed in as the token's account.
 * - DEVICE_SETTINGS: Plex Web's per-device "Automatically Sign In" setting
 *   ("Do not prompt to select a user or enter a PIN during startup on this
 *   device"). Without it, an account in a Plex Home (more than one user, or
 *   a PIN) starts at "Select User" on a fresh browser profile. UNVERIFIED
 *   until a live run passes with it (BACKLOG B4); found in the 4.160.0 bundle.
 */
import type { BrowserContext } from "@playwright/test";

export const TOKEN_STORAGE_KEYS = ["myPlexAccessToken"] as const;
export const DEVICE_SETTINGS = { storageKey: "deviceSettings", autoLogin: "autoLogin" } as const;

export interface AuthInit {
  keys: string[];
  token: string;
  deviceSettingsKey: string;
  autoLoginAttr: string;
}

/**
 * Runs in the page before Plex Web (addInitScript serializes it): keep it
 * self-contained. Sets the token and turns on "Automatically Sign In",
 * keeping any other device settings Plex Web saved during the test.
 */
export function authInitScript({ keys, token, deviceSettingsKey, autoLoginAttr }: AuthInit): void {
  try {
    const storage = window.localStorage;
    for (const k of keys) storage.setItem(k, token);
    let settings: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(storage.getItem(deviceSettingsKey) || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) settings = parsed as Record<string, unknown>;
    } catch {
      /* unreadable: replace it */
    }
    settings[autoLoginAttr] = true;
    storage.setItem(deviceSettingsKey, JSON.stringify(settings));
  } catch {
    /* storage blocked */
  }
}

export async function injectTokenAuth(context: BrowserContext, token: string | undefined): Promise<void> {
  if (!token) return; // e.g. an unclaimed server on an allowed network
  await context.addInitScript(authInitScript, {
    keys: [...TOKEN_STORAGE_KEYS],
    token,
    deviceSettingsKey: DEVICE_SETTINGS.storageKey,
    autoLoginAttr: DEVICE_SETTINGS.autoLogin,
  });
}
