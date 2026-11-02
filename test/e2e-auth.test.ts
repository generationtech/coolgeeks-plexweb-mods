// The e2e's storage injection (e2e/auth.ts), run against a fake localStorage.
import { afterEach, describe, expect, it, vi } from "vitest";
import { authInitScript, DEVICE_SETTINGS, TOKEN_STORAGE_KEYS, type AuthInit } from "../e2e/auth";

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
    setItem: (k: string, v: string) => void data.set(k, String(v)),
  };
}

const init: AuthInit = {
  keys: [...TOKEN_STORAGE_KEYS],
  token: "test-token",
  deviceSettingsKey: DEVICE_SETTINGS.storageKey,
  deviceSettings: { ...DEVICE_SETTINGS.values },
};
const injected = { autoLogin: true, shouldSyncSettings: false };

function run(storage: unknown) {
  vi.stubGlobal("window", { localStorage: storage });
  authInitScript(init);
}

afterEach(() => vi.unstubAllGlobals());

describe("e2e auth init script", () => {
  it("stores the token, turns on automatic sign-in and turns off settings sync on a fresh profile", () => {
    const s = fakeStorage();
    run(s);
    expect(s.data.get("myPlexAccessToken")).toBe("test-token");
    expect(JSON.parse(s.data.get("deviceSettings")!)).toEqual(injected);
  });

  it("keeps device settings Plex Web saved earlier (the script runs on every page load)", () => {
    const s = fakeStorage({ deviceSettings: JSON.stringify({ autoLogin: false, shouldSyncSettings: true, volume: 40, dismissedUnclaimedServers: { x: true } }) });
    run(s);
    expect(JSON.parse(s.data.get("deviceSettings")!)).toEqual({ ...injected, volume: 40, dismissedUnclaimedServers: { x: true } });
  });

  it.each(["not json", "[1,2]", "null", "42"])("replaces unusable device settings (%s)", (stored) => {
    const s = fakeStorage({ deviceSettings: stored });
    run(s);
    expect(JSON.parse(s.data.get("deviceSettings")!)).toEqual(injected);
  });

  it("does not throw when storage is blocked", () => {
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(() => run(blocked)).not.toThrow();
  });

  it("is self-contained, so addInitScript can serialize it", () => {
    const src = authInitScript.toString();
    expect(src).not.toMatch(/TOKEN_STORAGE_KEYS|DEVICE_SETTINGS|\bimport\b|require\(/);
  });
});
