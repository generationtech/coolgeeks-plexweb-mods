/**
 * E2E: on a real server, open a library, apply a non-default sort, use
 * "Play from here" on a mid-list item, then assert via GET /playQueues/<id>
 * that the queue order equals the visible (sorted) order from that item on.
 * Skipped when PLEX_URL is unset.
 */
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { injectTag, renderTag } from "../injector/html";
import { itemsFromSelected } from "../patches/play-from-here/playqueue";
import { injectTokenAuth } from "./auth";
import { e2eEnabled, e2eEnv } from "./env";
import { PlexApi } from "./plex-api";
import { PlexWeb, UI } from "./plex-ui";

test.skip(!e2eEnabled, "PLEX_URL is unset: e2e needs a real Plex Media Server (see BACKLOG.md)");

test("Play from here queues the visible sorted order from the clicked item", async ({ page, context, request }) => {
  const env = e2eEnv();
  const api = new PlexApi(request, env.url, env.token);
  const ui = new PlexWeb(page);
  const machineIdentifier = await api.machineIdentifier();

  await injectTokenAuth(context, env.token);
  if (env.inject === "route") {
    // Test the local build against the server's real bundle without touching the server.
    const runtime = readFileSync(join(import.meta.dirname, "..", "dist", "plexweb-mods.js"), "utf8");
    await page.route(/\/web\/index\.html(\?.*)?$/, async (route) => {
      const res = await route.fetch();
      const html = injectTag(await res.text(), renderTag({ version: "e2e", reportDelayMs: 3000 })).html;
      await route.fulfill({ response: res, body: html, headers: { ...res.headers(), "content-type": "text/html" } });
    });
    await page.route(/\/web\/plexweb-mods\.js(\?.*)?$/, (route) => route.fulfill({ body: runtime, contentType: "application/javascript" }));
  }

  await ui.openLibrary(ui.libraryUrl(env.url, machineIdentifier, env.sectionId));
  await ui.waitForRuntime();

  // 1. Non-default sort, captured from Plex Web's own listing request.
  const sorted = page.waitForResponse((r) => /\/library\/sections\/\d+\/all\?/.test(r.url()) && /[?&]sort=/.test(r.url()));
  await ui.applySort(env.sortLabel);
  const listingParams = new URL((await sorted).url()).searchParams;

  // 2. Visible order must match the server's order for the same params. The
  //    grid re-renders after a sort, so poll until it shows a contiguous run.
  const serverOrder = await api.listingKeys(env.sectionId, listingParams);
  expect(serverOrder.length, "need at least 3 items in the section").toBeGreaterThanOrEqual(3);
  const isContiguousRun = (v: string[]) => {
    const offset = serverOrder.indexOf(v[0] ?? "");
    return v.length >= 3 && offset >= 0 && serverOrder.slice(offset, offset + v.length).join() === v.join();
  };
  await expect.poll(async () => isContiguousRun(await ui.visibleRatingKeys()), { timeout: 20_000 }).toBe(true);
  const visible = await ui.visibleRatingKeys();
  expect(isContiguousRun(visible), "visible order equals the server's sorted order").toBe(true);

  // 3. Play from here on a mid-list item.
  const pick = visible[Math.floor(visible.length / 2)]!;
  const created = page.waitForResponse((r) => r.request().method() === "POST" && /\/playQueues\?/.test(r.url()));
  await ui.playFromHere(pick);
  const response = await created;
  expect(response.ok()).toBe(true);
  const playQueueID = String((await response.json()).MediaContainer.playQueueID);

  // 4. Queue order == visible/server order from the picked item onward.
  const queue = await api.playQueue(playQueueID);
  const fromPick = itemsFromSelected(queue);
  const expected = serverOrder.slice(serverOrder.indexOf(pick));
  expect(fromPick[0]).toBe(pick);
  expect(fromPick).toEqual(expected.slice(0, fromPick.length));
  expect(fromPick.length).toBeGreaterThanOrEqual(Math.min(expected.length, 2));

  // 5. Plex Web's native player opened.
  await expect(page.locator(UI.player).first()).toBeAttached({ timeout: 30_000 });
  const pfh = await page.evaluate(() => {
    const p = (window as any).__plexwebMods.plugins["play-from-here"];
    return { error: p.lastError, playback: p.lastResult?.playback, queue: p.lastResult?.queue?.id };
  });
  expect(pfh.error, "plugin reported no error").toBeNull();
  expect(pfh.playback, "started through Plex Web's own player").toBe("native");
  expect(pfh.queue).toBe(playQueueID);
  const status = await page.evaluate(() => (window as any).__plexwebMods.report({ final: true }));
  expect(status.failures, "no anchor failures at runtime").toEqual([]);
});
