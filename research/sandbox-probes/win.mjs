import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const { chromium } = createRequire(new URL("../../package.json", import.meta.url))("@playwright/test");
const runtime = readFileSync(new URL("../../dist/plexweb-mods.js", import.meta.url), "utf8");
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
const MID = (await (await fetch("http://127.0.0.1:32400/identity", { headers: { Accept: "application/json" } })).json()).MediaContainer.machineIdentifier;
await page.route(/\/web\/index\.html(\?.*)?$/, async (route) => { const res = await route.fetch(); const html = (await res.text()).replace("<script", `<script src="plexweb-mods.js?v=t" data-chunk-globals="webpackChunkplex_web_client"></script><script`); await route.fulfill({ response: res, body: html, headers: { ...res.headers(), "content-type": "text/html" } }); });
await page.route(/\/web\/plexweb-mods\.js(\?.*)?$/, (r) => r.fulfill({ body: runtime, contentType: "application/javascript" }));
const seq = []; const pqReqs = [];
page.on("request", (r) => { const u = new URL(r.url()); if (u.pathname === "/:/timeline") { const rk = u.searchParams.get("ratingKey"); const st = u.searchParams.get("state"); if (seq.at(-1)?.rk !== rk) seq.push({ rk, st, t: Date.now() }); } if (/^\/playQueues\/\d+/.test(u.pathname)) pqReqs.push(u.pathname + "?" + [...u.searchParams].filter(([k]) => !/^X-Plex/.test(k)).map(([k, v]) => k + "=" + v).join("&")); });
const lib = `http://127.0.0.1:32400/web/index.html#!/media/${MID}/com.plexapp.plugins.library?source=4&pivot=library`;
await page.goto(lib); await page.waitForTimeout(6000);
const setup = page.getByText("Finish Setup"); if (await setup.count()) { await setup.first().click(); await page.waitForTimeout(2000); await page.goto(lib); await page.waitForTimeout(5000); }
const d = page.getByText("Don't show this again"); if (await d.count()) { await d.first().click(); await page.waitForTimeout(2000); }
await page.locator('button[aria-haspopup="true"]', { hasText: /^By / }).first().click(); await page.getByRole("menuitem", { name: "Year", exact: true }).click(); await page.waitForTimeout(3000);
const order = (await (await fetch("http://127.0.0.1:32400/library/sections/4/all?type=1&sort=year:desc", { headers: { Accept: "application/json" } })).json()).MediaContainer.Metadata.map((m) => m.ratingKey);
const start = 30;
const r = await page.evaluate(async (rk) => { const res = await window.__plexwebMods.plugins["play-from-here"].play({ ratingKey: rk }); return { q: res?.queue?.id, n: res?.queue?.items?.length, off: res?.queue?.selectedItemOffset, err: window.__plexwebMods.plugins["play-from-here"].lastError }; }, order[start]);
console.log("play:", JSON.stringify(r));
await page.waitForTimeout(4000);
const offsetNow = () => order.indexOf(seq.at(-1)?.rk);
const step = async (label) => {
  const before = seq.length;
  await page.getByRole("button", { name: label, exact: true }).click();
  for (let i = 0; i < 50 && seq.length === before; i++) await page.waitForTimeout(100);
  return offsetNow();
};
await page.getByRole("button", { name: "Pause", exact: true }).click(); await page.waitForTimeout(1500);
const fwd = []; for (let i = 0; i < 24; i++) fwd.push(await step("Next"));
console.log("Next presses -> offsets:", fwd.join(" "));
const back = []; for (let i = 0; i < 50 && offsetNow() > 5; i++) back.push(await step("Previous"));
console.log("Previous presses -> offsets:", back.join(" "));
console.log("states seen:", [...new Set(seq.map((s) => s.st))].join(","));
console.log("playQueue requests:", [...new Set(pqReqs)].join("\n   "));
await page.screenshot({ path: process.argv[2] + "/win-player.png" });
await browser.close();
