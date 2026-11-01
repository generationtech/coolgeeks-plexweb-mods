import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const { chromium } = createRequire(new URL("../../package.json", import.meta.url))("@playwright/test");
const runtime = readFileSync(new URL("../../dist/plexweb-mods.js", import.meta.url), "utf8");
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
const H = { Accept: "application/json", "X-Plex-Client-Identifier": "probe" };
const MID = (await (await fetch("http://127.0.0.1:32400/identity", { headers: H })).json()).MediaContainer.machineIdentifier;
await page.route(/\/web\/index\.html(\?.*)?$/, async (route) => { const res = await route.fetch(); const html = (await res.text()).replace("<script", `<script src="plexweb-mods.js?v=t" data-chunk-globals="webpackChunkplex_web_client" data-opt-pfh-player="companion"></script><script`); await route.fulfill({ response: res, body: html, headers: { ...res.headers(), "content-type": "text/html" } }); });
await page.route(/\/web\/plexweb-mods\.js(\?.*)?$/, (r) => r.fulfill({ body: runtime, contentType: "application/javascript" }));
const comp = []; page.on("response", async (r) => { if (/\/player\/playback\/playMedia/.test(r.url())) comp.push({ status: r.status(), body: (await r.text().catch(() => "")).slice(0, 300) }); });
const ws = []; page.on("websocket", (w) => ws.push(new URL(w.url()).pathname));
const lib = `http://127.0.0.1:32400/web/index.html#!/media/${MID}/com.plexapp.plugins.library?source=1&pivot=library`;
await page.goto(lib); await page.waitForTimeout(6000);
const setup = page.getByText("Finish Setup"); if (await setup.count()) { await setup.first().click(); await page.waitForTimeout(2000); await page.goto(lib); await page.waitForTimeout(5000); }
const d = page.getByText("Don't show this again"); if (await d.count()) { await d.first().click(); await page.waitForTimeout(2000); }
const clients = async () => (await (await fetch("http://127.0.0.1:32400/clients", { headers: H })).json()).MediaContainer;
console.log("PMS /clients while Plex Web is open:", JSON.stringify(await clients()));
const r = await page.evaluate(async () => { const p = window.__plexwebMods.plugins["play-from-here"]; const res = await p.play({ ratingKey: "3" }); return { path: p.activePath(), result: res?.playback ?? null, err: p.lastError, clientId: p.tracker.headersFor(location.origin)["X-Plex-Client-Identifier"] ? "present" : "missing" }; });
await page.waitForTimeout(4000);
console.log("plugin:", JSON.stringify(r));
console.log("playMedia responses:", JSON.stringify(comp));
console.log("video element:", await page.locator("video").count(), "| websockets opened by Plex Web:", JSON.stringify([...new Set(ws)]));
await browser.close();
