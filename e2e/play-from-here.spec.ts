/**
 * E2E for "Play from here" against a real Plex Media Server (skipped when
 * PLEX_URL is unset). Generated-media libraries come from
 * scripts/sandbox-pms.sh; the tests for the TV, Other Videos and 300-item
 * libraries skip unless their section ids are set.
 *
 * Every test asserts, via GET /playQueues/<id>, that the queue Plex built:
 *   - selects the clicked item at its index in the visible order, and
 *   - matches the visible order on both sides of it (previous and next items).
 */
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { injectTag, renderTag } from "../injector/html";
import { injectTokenAuth } from "./auth";
import { e2eEnabled, e2eEnv, expectedPath, type E2EEnv } from "./env";
import { PlexApi } from "./plex-api";
import { PlexWeb, UI } from "./plex-ui";

test.skip(!e2eEnabled, "PLEX_URL is unset: e2e needs a Plex Media Server (scripts/sandbox-pms.sh start, or see BACKLOG.md)");

interface Ctx {
  env: E2EEnv;
  api: PlexApi;
  ui: PlexWeb;
  machineIdentifier: string;
  /** Rating key Plex Web last reported playing (from its /:/timeline requests). */
  nowPlaying(): string | undefined;
  /** Every item Plex Web reported playing, in order (consecutive repeats collapsed). */
  played(): string[];
}

async function setup(page: Page, context: Parameters<typeof injectTokenAuth>[0], request: ConstructorParameters<typeof PlexApi>[0]): Promise<Ctx> {
  const env = e2eEnv();
  const api = new PlexApi(request, env.url, env.token);
  const ui = new PlexWeb(page);
  await injectTokenAuth(context, env.token);
  if (env.inject === "route") {
    // The local build against the server's real bundle, server untouched.
    const runtime = readFileSync(join(import.meta.dirname, "..", "dist", "plexweb-mods.js"), "utf8");
    await page.route(/\/web\/index\.html(\?.*)?$/, async (route) => {
      const res = await route.fetch();
      const tag = renderTag({ version: "e2e", reportDelayMs: 3000, chunkGlobals: ["webpackChunkplex_web_client"], options: { "pfh-player": env.player } });
      await route.fulfill({ response: res, body: injectTag(await res.text(), tag).html, headers: { ...res.headers(), "content-type": "text/html" } });
    });
    await page.route(/\/web\/plexweb-mods\.js(\?.*)?$/, (route) => route.fulfill({ body: runtime, contentType: "application/javascript" }));
  }
  const played: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    const rk = u.pathname.endsWith("/:/timeline") ? u.searchParams.get("ratingKey") : null;
    if (rk && played.at(-1) !== rk) played.push(rk);
  });
  return { env, api, ui, machineIdentifier: await api.machineIdentifier(), nowPlaying: () => played.at(-1), played: () => [...played] };
}

/** Clicks "Play from here" on `pick` and returns the created queue's id. */
async function playFromHere(c: Ctx, pick: string): Promise<string> {
  const created = c.ui.page.waitForResponse((r) => r.request().method() === "POST" && /\/playQueues\?/.test(r.url()));
  await c.ui.playFromHere(pick);
  const response = await created;
  expect(response.ok()).toBe(true);
  return String((await response.json()).MediaContainer.playQueueID);
}

/** The queue selects `pick` at its visible index, and its window matches the visible order around it. */
async function expectQueueFollows(c: Ctx, queueId: string, order: string[], pick: string): Promise<void> {
  const mc = await c.api.playQueueRaw(queueId);
  const items: string[] = (mc.Metadata ?? []).map((m: any) => String(m.ratingKey));
  const index = order.indexOf(pick);
  expect(index, "clicked item is in the visible order").toBeGreaterThanOrEqual(0);
  expect(Number(mc.playQueueSelectedItemOffset), "selected offset = index of the clicked item").toBe(index);
  expect(Number(mc.playQueueTotalCount), "queue holds the whole visible list").toBe(order.length);
  const selectedAt = (mc.Metadata ?? []).findIndex((m: any) => String(m.playQueueItemID) === String(mc.playQueueSelectedItemID));
  expect(items[selectedAt]).toBe(pick);
  if (index > 0) expect(selectedAt, "queue contains items before the clicked one").toBeGreaterThan(0);
  const first = index - selectedAt; // visible index of the window's first item
  expect(items, "previous and next items follow the visible order").toEqual(order.slice(first, first + items.length));
}

async function expectNativePlayback(c: Ctx, queueId: string): Promise<void> {
  await expect(c.ui.page.locator(UI.player).first()).toBeAttached({ timeout: 30_000 });
  const pfh = await c.ui.page.evaluate(() => {
    const mods = (window as any).__plexwebMods;
    const p = mods.plugins["play-from-here"];
    return { error: p.lastError, playback: p.lastResult?.playback, queue: p.lastResult?.queue?.id, forced: mods.config.options["pfh-player"] ?? "auto" };
  });
  expect(pfh.error, "plugin reported no error").toBeNull();
  // route mode forces PLEX_E2E_PLAYER; server mode uses what reapply.sh --opt pfh-player=... set
  expect(pfh.playback, `playback path for pfh-player=${pfh.forced}`).toBe(expectedPath(pfh.forced));
  expect(pfh.queue).toBe(queueId);
  const report = await c.ui.page.evaluate(() => (window as any).__plexwebMods.report({ final: true }));
  expect(report.failures, "no anchor failures at runtime").toEqual([]);
}

/** Sorts a library page and returns the server's order for Plex Web's own listing request. */
async function sortAndRead(c: Ctx, sectionId: string, sortLabel: string): Promise<string[]> {
  const sorted = c.ui.page.waitForResponse((r) => new RegExp(`/library/sections/${sectionId}/all\\?`).test(r.url()) && /[?&]sort=/.test(r.url()));
  await c.ui.applySort(sortLabel);
  const params = new URL((await sorted).url()).searchParams;
  const order = await c.api.listingKeys(sectionId, params);
  expect(order.length, "need at least 3 items").toBeGreaterThanOrEqual(3);
  await expectVisibleRun(c, order);
  return order;
}

/** Waits until the page shows a contiguous run of `order` (the grid re-renders after a sort). */
async function expectVisibleRun(c: Ctx, order: string[]): Promise<string[]> {
  const run = async () => (await c.ui.visibleRatingKeys()).filter((k) => order.includes(k));
  const contiguous = (v: string[]) => {
    const offset = order.indexOf(v[0] ?? "");
    return v.length >= Math.min(3, order.length) && offset >= 0 && order.slice(offset, offset + v.length).join() === v.join();
  };
  await expect.poll(async () => contiguous(await run()), { timeout: 20_000 }).toBe(true);
  return run();
}

async function openSection(c: Ctx, sectionId: string): Promise<void> {
  await c.ui.open(c.ui.libraryUrl(c.env.url, c.machineIdentifier, sectionId));
  await c.ui.waitForRuntime();
}

test("grid: queue follows the visible sort, before and after the clicked item", async ({ page, context, request }) => {
  const c = await setup(page, context, request);
  await openSection(c, c.env.sectionId);
  const order = await sortAndRead(c, c.env.sectionId, c.env.sortLabel);
  const visible = await expectVisibleRun(c, order);
  const pick = visible[Math.floor(visible.length / 2)]!;
  const queueId = await playFromHere(c, pick);
  await expectQueueFollows(c, queueId, order, pick);
  await expectNativePlayback(c, queueId);
});

for (const view of ["Detail View", "Table View"] as const) {
  test(`${view}: queue follows the visible sort`, async ({ page, context, request }) => {
    const c = await setup(page, context, request);
    await openSection(c, c.env.sectionId);
    await c.ui.setViewStyle(view);
    const order = await sortAndRead(c, c.env.sectionId, c.env.sortLabel);
    const visible = await expectVisibleRun(c, order);
    const pick = visible[Math.floor(visible.length / 2)]!;
    const queueId = await playFromHere(c, pick);
    await expectQueueFollows(c, queueId, order, pick);
    await expectNativePlayback(c, queueId);
    await c.ui.setViewStyle("Grid View").catch(() => {}); // Plex Web remembers the style per library
  });
}

test("TV: Play from here on an episode in a season view", async ({ page, context, request }) => {
  const env = e2eEnv();
  test.skip(!env.tvSectionId, "PLEX_E2E_TV_SECTION_ID is unset");
  const c = await setup(page, context, request);
  const show = (await c.api.listingKeys(env.tvSectionId!, new URLSearchParams("type=2")))[0]!;
  const season = (await c.api.childrenKeys(show))[0]!;
  const episodes = await c.api.childrenKeys(season);
  expect(episodes.length, "need at least 3 episodes in the first season").toBeGreaterThanOrEqual(3);
  await c.ui.open(c.ui.detailsUrl(env.url, c.machineIdentifier, season));
  await c.ui.waitForRuntime();
  await expectVisibleRun(c, episodes);
  const pick = episodes[Math.floor(episodes.length / 2)]!;
  const queueId = await playFromHere(c, pick);
  await expectQueueFollows(c, queueId, episodes, pick);
  await expectNativePlayback(c, queueId);
});

test("Other Videos: queue follows the visible sort", async ({ page, context, request }) => {
  const env = e2eEnv();
  test.skip(!env.otherSectionId, "PLEX_E2E_OTHER_SECTION_ID is unset");
  const c = await setup(page, context, request);
  await openSection(c, env.otherSectionId!);
  const order = await sortAndRead(c, env.otherSectionId!, process.env.PLEX_E2E_OTHER_SORT_LABEL || "Date Added");
  const visible = await expectVisibleRun(c, order);
  const pick = visible[Math.floor(visible.length / 2)]!;
  const queueId = await playFromHere(c, pick);
  await expectQueueFollows(c, queueId, order, pick);
  await expectNativePlayback(c, queueId);
});

/**
 * Starts "Play from here" at visible index `start` of the 300-item library
 * (2-second clips) and returns the visible order and the queue's first window.
 */
async function startInBigLibrary(c: Ctx, start: number) {
  await openSection(c, c.env.bigSectionId!);
  await c.ui.setViewStyle("Table View"); // compact rows: item 31 is reachable without paging
  const order = await sortAndRead(c, c.env.bigSectionId!, c.env.sortLabel);
  expect(order.length).toBeGreaterThanOrEqual(100);
  const pick = order[start]!;
  const queueId = await playFromHere(c, pick);
  await expectQueueFollows(c, queueId, order, pick);
  await expectNativePlayback(c, queueId);
  // Plex windows the queue: only part of it comes back by default.
  const mc = await c.api.playQueueRaw(queueId);
  const returned = (mc.Metadata ?? []).length;
  expect(returned, "PMS windows the play queue").toBeLessThan(order.length);
  const before = (mc.Metadata ?? []).findIndex((m: any) => String(m.playQueueItemID) === String(mc.playQueueSelectedItemID));
  const windowStart = start - before;
  return { order, queueId, windowStart, windowEnd: windowStart + returned - 1 };
}

test("300 items: the queue is windowed, and Next/Previous follow the visible sort across the window edges", async ({ page, context, request }) => {
  const env = e2eEnv();
  test.skip(!env.bigSectionId, "PLEX_E2E_BIG_SECTION_ID is unset");
  test.setTimeout(240_000);
  const c = await setup(page, context, request);
  const { order, windowStart, windowEnd } = await startInBigLibrary(c, 30);

  // Walk with the player's own controls (paused, so autoplay cannot race the clicks).
  await expect.poll(() => c.nowPlaying(), { timeout: 20_000 }).toBeDefined();
  await page.getByRole("button", { name: UI.playerPause, exact: true }).click();
  const offsetOf = (rk?: string) => order.indexOf(rk ?? "");
  let at = offsetOf(c.nowPlaying());
  while (at <= windowEnd + 1) {
    const next = offsetOf(await c.ui.playerStep(UI.playerNext, c.nowPlaying));
    expect(next, `Next from visible #${at} goes to #${at + 1}`).toBe(at + 1);
    at = next;
  }
  while (at >= windowStart - 1 && at > 0) {
    const prev = offsetOf(await c.ui.playerStep(UI.playerPrevious, c.nowPlaying));
    expect(prev, `Previous from visible #${at} goes to #${at - 1}`).toBe(at - 1);
    at = prev;
  }
  expect(at, "walked past the window's first item").toBeLessThan(windowStart);
});

test("300 items: unpaused autoplay follows the visible sort across the window edge", async ({ page, context, request }) => {
  const env = e2eEnv();
  test.skip(!env.bigSectionId, "PLEX_E2E_BIG_SECTION_ID is unset");
  test.setTimeout(300_000);
  const c = await setup(page, context, request);
  const start = 30;
  const { order, windowEnd } = await startInBigLibrary(c, start);

  // No clicks from here on: Plex Web plays each 2-second clip and starts the next by itself.
  const offsetOf = (rk?: string) => order.indexOf(rk ?? "");
  await expect
    .poll(() => offsetOf(c.nowPlaying()), { timeout: 200_000, intervals: [1_000], message: "autoplay reaches past the queue window's last item" })
    .toBeGreaterThan(windowEnd + 1);

  const played = c.played().map(offsetOf);
  const fromPick = played.slice(played.indexOf(start));
  expect(fromPick[0], "playback started at the clicked item").toBe(start);
  expect(fromPick, "every automatically started item is the next one in the visible order").toEqual(
    fromPick.map((_, i) => start + i),
  );
  const summary = `autoplay walked visible #${start}..#${fromPick.at(-1)} (${fromPick.length} items); the queue's first window ended at #${windowEnd}`;
  test.info().annotations.push({ type: "autoplay", description: summary });
  console.log(summary);
});
