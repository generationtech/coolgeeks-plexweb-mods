import { createRequire } from "node:module";
const { chromium } = createRequire(new URL("../../package.json", import.meta.url))("@playwright/test");
const out = process.argv[2];
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
const logs = []; page.on("console", (m) => { if (m.text().includes("plexweb-mods")) logs.push(m.type() + ": " + m.text().slice(0, 300)); });
const MID = (await (await fetch("http://127.0.0.1:32400/identity", { headers: { Accept: "application/json" } })).json()).MediaContainer.machineIdentifier;
const lib = `http://127.0.0.1:32400/web/index.html#!/media/${MID}/com.plexapp.plugins.library?source=1&pivot=library`;
await page.goto(lib); await page.waitForTimeout(7000);
const setup = page.getByText("Finish Setup"); if (await setup.count()) { await setup.first().click(); await page.waitForTimeout(2000); await page.goto(lib); await page.waitForTimeout(5000); }
const d = page.getByText("Don't show this again"); if (await d.count()) { await d.first().click(); await page.waitForTimeout(2000); }
await page.locator('button[aria-haspopup="true"]', { hasText: /^By / }).first().click(); await page.getByRole("menuitem", { name: "Year", exact: true }).click(); await page.waitForTimeout(2500);
const card = page.locator('[data-testid="cellItem"]').nth(2); await card.hover(); await card.locator('button[aria-label="More Actions"]').click(); await page.waitForTimeout(800);
await page.screenshot({ path: out + "/ui5-menu.png" });
await page.locator('[data-plexweb-mods="play-from-here"]').click(); await page.waitForTimeout(6000);
await page.screenshot({ path: out + "/ui5-player.png" });
const st = await page.evaluate(() => { const m = window.__plexwebMods; const p = m.plugins["play-from-here"]; return { status: m.status, playback: p.lastResult?.playback, queue: p.lastResult?.queue?.id, fromSel: p.lastResult?.queue?.items?.map(i => i.ratingKey).join(" "), sel: p.lastResult?.queue?.selectedRatingKey, err: p.lastError, video: !!document.querySelector("video"), menuOpen: !!document.querySelector('[data-plexweb-mods="play-from-here"]') }; });
console.log(JSON.stringify(st)); console.log(logs.join("\n"));
await page.waitForTimeout(9000);
console.log("status after report delay:", await page.evaluate(() => window.__plexwebMods.status), "| attr:", await page.evaluate(() => document.documentElement.dataset.plexwebModsStatus));
await browser.close();
