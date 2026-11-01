import { createRequire } from "node:module";
const { chromium } = createRequire(new URL("../../package.json", import.meta.url))("@playwright/test");
const out = process.argv[2];
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
const MID = (await (await fetch("http://127.0.0.1:32400/identity", { headers: { Accept: "application/json" } })).json()).MediaContainer.machineIdentifier;
const lib = (id) => `http://127.0.0.1:32400/web/index.html#!/media/${MID}/com.plexapp.plugins.library?source=${id}&pivot=library`;
const reqs = []; page.on("request", (r) => { const u = new URL(r.url()); if (/\/library\/sections\/\d+\/all/.test(u.pathname)) reqs.push(u.pathname + "?" + [...u.searchParams].filter(([k]) => !/^X-Plex-/.test(k)).map(([k, v]) => `${k}=${v}`).join("&")); });
await page.goto(lib(1)); await page.waitForTimeout(6000);
const setup = page.getByText("Finish Setup"); if (await setup.count()) { await setup.first().click(); await page.waitForTimeout(2000); await page.goto(lib(1)); await page.waitForTimeout(5000); }
const d = page.getByText("Don't show this again"); if (await d.count()) { await d.first().click(); await page.waitForTimeout(2000); }
for (const view of ["Detail View", "Table View"]) {
  await page.locator('[data-testid="toolbarView"]').click(); await page.waitForTimeout(500);
  await page.getByRole("menuitem", { name: view }).or(page.getByText(view, { exact: true })).first().click(); await page.waitForTimeout(2500);
  const info = await page.evaluate(() => {
    const a = document.querySelector('a[href*="%2Flibrary%2Fmetadata%2F"]');
    const chain = []; let n = a; for (let i = 0; n && i < 8; i++, n = n.parentElement) chain.push(`${n.tagName.toLowerCase()}${n.getAttribute("data-testid") ? "[testid=" + n.getAttribute("data-testid") + "]" : ""}${n.getAttribute("role") ? "[role=" + n.getAttribute("role") + "]" : ""} links=${n.querySelectorAll('a[href*="%2Flibrary%2Fmetadata%2F"]').length} more=${n.querySelectorAll('button[aria-label="More Actions"]').length}`);
    return chain.join("\n   ");
  });
  const keys = await page.$$eval('a[href*="%2Flibrary%2Fmetadata%2F"]', (as) => [...new Set(as.map((a) => /metadata%2F(\d+)/.exec(a.getAttribute("href"))[1]))].join(" "));
  console.log(`== ${view}: order ${keys}\n   ${info}`);
  const row = page.locator('a[href*="%2Flibrary%2Fmetadata%2F3"]').first();
  await row.hover(); await page.waitForTimeout(400);
  console.log("   more buttons visible after hover:", await page.locator('button[aria-label="More Actions"]:visible').count());
  await page.screenshot({ path: `${out}/ui8-${view.split(" ")[0]}.png` });
}
console.log("listing reqs:", [...new Set(reqs)].join("\n   "));
// back to grid
await page.locator('[data-testid="toolbarView"]').click(); await page.getByText("Grid View", { exact: false }).first().click(); await page.waitForTimeout(1000);
await browser.close();
