import { createRequire } from "node:module";
const { chromium } = createRequire(new URL("../../package.json", import.meta.url))("@playwright/test");
const out = process.argv[2];
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
const MID = (await (await fetch("http://127.0.0.1:32400/identity", { headers: { Accept: "application/json" } })).json()).MediaContainer.machineIdentifier;
const reqs = []; page.on("request", (r) => { const u = new URL(r.url()); if (u.port === "32400" && /^\/(library|hubs)/.test(u.pathname)) reqs.push(u.pathname + "?" + [...u.searchParams].filter(([k]) => !/^X-Plex-/.test(k)).map(([k, v]) => `${k}=${v}`).join("&")); });
const clean = (s) => s.replaceAll(MID, "<MID>");
const lib = (id) => `http://127.0.0.1:32400/web/index.html#!/media/${MID}/com.plexapp.plugins.library?source=${id}&pivot=library`;
await page.goto(lib(2)); await page.waitForTimeout(6000);
const setup = page.getByText("Finish Setup"); if (await setup.count()) { await setup.first().click(); await page.waitForTimeout(2000); await page.goto(lib(2)); await page.waitForTimeout(5000); }
const d = page.getByText("Don't show this again"); if (await d.count()) { await d.first().click(); await page.waitForTimeout(2000); }
console.log("TV grid URL:", clean(page.url()));
reqs.length = 0;
await page.locator('[data-testid="cellItem"]').first().locator("a").first().click(); await page.waitForTimeout(4000);
console.log("show URL:", clean(page.url())); console.log("show reqs:", reqs.slice(0, 8).join("\n   "));
reqs.length = 0;
await page.getByText("Season 1", { exact: true }).first().click(); await page.waitForTimeout(4000);
console.log("season URL:", clean(page.url())); console.log("season reqs:", reqs.slice(0, 8).join("\n   "));
const links = await page.$$eval('a[href*="%2Flibrary%2Fmetadata%2F"]', (as) => [...new Set(as.map((a) => decodeURIComponent(/key=([^&]+)/.exec(a.getAttribute("href"))?.[1] ?? "")))]);
console.log("season links:", links.join(" "));
const more = await page.$$eval('button[aria-label="More Actions"], button[aria-label*="More" i]', (bs) => bs.map((b) => b.getAttribute("aria-label")));
console.log("more buttons:", more.length, [...new Set(more)].join(","));
const cells = await page.locator('[data-testid="cellItem"]').count(); console.log("cellItems:", cells);
await page.screenshot({ path: out + "/ui7-season.png" });
// list view on Movies
reqs.length = 0;
await page.goto(lib(1)); await page.waitForTimeout(5000);
await page.locator('[data-testid="toolbarView"]').click(); await page.waitForTimeout(800);
const styles = await page.$$eval('[role="menuitem"], [role="menuitemradio"]', (els) => els.map((e) => (e.textContent || "").trim()));
console.log("view styles:", styles.join(" | "));
await page.screenshot({ path: out + "/ui7-viewmenu.png" });
await browser.close();
