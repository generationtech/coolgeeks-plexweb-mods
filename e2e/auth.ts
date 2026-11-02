/**
 * Token auth injected into storage before Plex Web boots. Never a stored
 * login (no storageState files). The storage keys are Plex Web internals;
 * keep them here.
 *
 * - TOKEN_STORAGE_KEYS: verified on Plex Web 4.160.0 against a claimed
 *   server (2026-11-01): Plex Web signed in as the token's account.
 * - DEVICE_SETTINGS, two of Plex Web's per-device settings (the JSON under
 *   `deviceSettings`), both found in the 4.160.0 bundle:
 *   - `autoLogin` = true, "Automatically Sign In" ("Do not prompt to select
 *     a user or enter a PIN during startup on this device"). Without it, an
 *     account in a Plex Home (more than one user, or a PIN) starts at
 *     "Select User" on a fresh browser profile. Verified on 4.160.0
 *     (2026-11-01): the grid test got past sign-in and passed.
 *   - `shouldSyncSettings` = false, "Turn off settings sync": the sorts and
 *     view styles the tests pick must not sync to the account (a real
 *     account remembers them per library, on every device). UNVERIFIED
 *     until a live run shows the account's settings unchanged (BACKLOG B4).
 */
import type { BrowserContext } from "@playwright/test";

export const TOKEN_STORAGE_KEYS = ["myPlexAccessToken"] as const;
export const DEVICE_SETTINGS = {
  storageKey: "deviceSettings",
  values: { autoLogin: true, shouldSyncSettings: false },
} as const;

export interface AuthInit {
  keys: string[];
  token: string;
  deviceSettingsKey: string;
  /** Merged into the stored device settings; other settings are kept. */
  deviceSettings: Record<string, unknown>;
}

/**
 * Runs in the page before Plex Web (addInitScript serializes it): keep it
 * self-contained. Sets the token and the device settings, keeping any
 * other device settings Plex Web saved during the test.
 */
export function authInitScript({ keys, token, deviceSettingsKey, deviceSettings }: AuthInit): void {
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
    for (const k of Object.keys(deviceSettings)) settings[k] = deviceSettings[k];
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
    deviceSettings: { ...DEVICE_SETTINGS.values },
  });
}
