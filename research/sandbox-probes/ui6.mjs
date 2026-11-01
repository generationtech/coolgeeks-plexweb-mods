import { createRequire } from "node:module";
const { chromium } = createRequire(new URL("../../package.json", import.meta.url))("@playwright/test");
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
const MID = (await (await fetch("http://127.0.0.1:32400/identity", { headers: { Accept: "application/json" } })).json()).MediaContainer.machineIdentifier;
const posts = []; page.on("request", (r) => { if (r.method() === "POST" && /\/playQueues/.test(r.url())) { const u = new URL(r.url()); posts.push({ type: u.searchParams.get("type"), uri: u.searchParams.get("uri").replace(MID, "<MID>"), key: u.searchParams.get("key"), shuffle: u.searchParams.get("shuffle"), continuous: u.searchParams.get("continuous") }); } });
const lib = `http://127.0.0.1:32400/web/index.html#!/media/${MID}/com.plexapp.plugins.library?source=1&pivot=library`;
await page.goto(lib); await page.waitForTimeout(6000);
const setup = page.getByText("Finish Setup"); if (await setup.count()) { await setup.first().click(); await page.waitForTimeout(2000); await page.goto(lib); await page.waitForTimeout(5000); }
const d = page.getByText("Don't show this again"); if (await d.count()) { await d.first().click(); await page.waitForTimeout(2000); }
await page.locator('button[aria-haspopup="true"]', { hasText: /^By / }).first().click(); await page.getByRole("menuitem", { name: "Year", exact: true }).click(); await page.waitForTimeout(2500);
// toolbar Play (library-wide) — the first "Play" button outside cards
await page.locator('button[aria-label="Play"]:not([data-testid="cellItem"] *)').first().click(); await page.waitForTimeout(4000);
console.log(JSON.stringify(posts, null, 1));
await browser.close();
