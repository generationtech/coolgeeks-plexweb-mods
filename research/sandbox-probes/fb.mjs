import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const req = createRequire(new URL("../../package.json", import.meta.url));
const { chromium } = req("@playwright/test");
const player = process.argv[2] ?? "fallback";
const runtime = readFileSync(new URL("../../dist/plexweb-mods.js", import.meta.url), "utf8");
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
const MID = (await (await fetch("http://127.0.0.1:32400/identity", { headers: { Accept: "application/json" } })).json()).MediaContainer.machineIdentifier;
await page.route(/\/web\/index\.html(\?.*)?$/, async (route) => {
  const res = await route.fetch(); let html = await res.text();
  html = html.replace("<script", `<script src="plexweb-mods.js?v=t" data-report-delay-ms="2000" data-opt-pfh-player="${player}"></script><script`);
  await route.fulfill({ response: res, body: html, headers: { ...res.headers(), "content-type": "text/html" } });
});
await page.route(/\/web\/plexweb-mods\.js(\?.*)?$/, (r) => r.fulfill({ body: runtime, contentType: "application/javascript" }));
const posts = []; page.on("response", async (r) => { if (r.request().method() === "POST" && /\/playQueues\?/.test(r.url())) { const u = new URL(r.url()); const j = await r.json().catch(() => null); posts.push({ uri: u.searchParams.get("uri").replace(MID, "<MID>"), key: u.searchParams.get("key"), id: j?.MediaContainer?.playQueueID, off: j?.MediaContainer?.playQueueSelectedItemOffset, order: (j?.MediaContainer?.Metadata ?? []).map((m) => m.ratingKey).join(" ") }); } });
page.on("console", (m) => { if (/plexweb-mods/.test(m.text())) console.log("console:", m.type(), m.text().slice(0, 250)); });
const lib = `http://127.0.0.1:32400/web/index.html#!/media/${MID}/com.plexapp.plugins.library?source=1&pivot=library`;
await page.goto(lib); await page.waitForTimeout(6000);
const setup = page.getByText("Finish Setup"); if (await setup.count()) { await setup.first().click(); await page.waitForTimeout(2000); await page.goto(lib); await page.waitForTimeout(5000); }
const d = page.getByText("Don't show this again"); if (await d.count()) { await d.first().click(); await page.waitForTimeout(2000); }
await page.locator('button[aria-haspopup="true"]', { hasText: /^By / }).first().click(); await page.getByRole("menuitem", { name: "Year", exact: true }).click(); await page.waitForTimeout(2500);
console.log("activePath:", JSON.stringify(await page.evaluate(() => window.__plexwebMods.plugins["play-from-here"].activePath())));
const card = page.locator('[data-testid="cellItem"]').nth(2); await card.hover(); await card.locator('button[aria-label="More Actions"]').click(); await page.waitForTimeout(600);
await page.locator('[data-plexweb-mods="play-from-here"]').click(); await page.waitForTimeout(6000);
const st = await page.evaluate(() => { const p = window.__plexwebMods.plugins["play-from-here"]; return { playback: p.lastResult?.playback, queue: p.lastResult?.queue?.id ?? null, err: p.lastError, video: !!document.querySelector("video"), status: window.__plexwebMods.status, groups: window.__plexwebMods.report({ final: true }).groups }; });
console.log(JSON.stringify(st)); console.log("POSTs:", JSON.stringify(posts, null, 1));
const again = await page.evaluate(async () => {
  const p = window.__plexwebMods.plugins["play-from-here"];
  const app = p.native.getAppModel();
  const player = app.get("ui").get("audioVideoPlayer");
  const before = player.get("playQueue")?.get("playQueueID");
  const r = await p.play({ ratingKey: "6" });
  await new Promise((res) => setTimeout(res, 5000));
  const q = player.get("playQueue");
  return { before, created: r?.queue?.id, nowPlayingQueue: q?.get("playQueueID"), items: q?.get("playQueueItems")?.length, selected: q?.get("playQueueSelectedMetadataItemID"), paused: player.get("isPaused"), open: player.get("isOpen") };
});
console.log("SECOND PLAY:", JSON.stringify(again));
await page.screenshot({ path: `${process.argv[3] ?? "."}/fb-${player}.png` });
await browser.close();
