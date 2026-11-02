/**
 * E2E against a REAL Plex Media Server. Configured only from env vars (see
 * .env.example); every test skips when PLEX_URL is unset, so this is safe to
 * run anywhere. Auth is a token injected into storage by e2e/auth.ts, never a
 * stored login: no storageState files are read or written.
 *
 * Traces/screenshots can contain tokens and library names: they are off by
 * default, gitignored, and must never be uploaded. Enable with PW_TRACE=1.
 */
import { defineConfig, devices } from "@playwright/test";

const trace = process.env.PW_TRACE === "1";

export default defineConfig({
  testDir: "e2e",
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  reporter: [["list"]],
  use: {
    ...(process.env.PLEX_URL ? { baseURL: process.env.PLEX_URL } : {}),
    trace: trace ? "retain-on-failure" : "off",
    screenshot: trace ? "only-on-failure" : "off",
    video: "off",
    actionTimeout: 30_000, // fail a stuck click in seconds, not at the 2-minute test timeout
    ignoreHTTPSErrors: process.env.PLEX_E2E_IGNORE_TLS === "1",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        ...(process.env.PW_CHROMIUM_PATH ? { launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH } } : {}),
      },
    },
  ],
});
