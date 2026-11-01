import { createRequire } from "node:module";
const { chromium } = createRequire(new URL("../../package.json", import.meta.url))("@playwright/test");
const out = process.argv[2];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
const MID = (await (await fetch("http://127.0.0.1:32400/identity", { headers: { Accept: "application/json" } })).json()).MediaContainer.machineIdentifier;
const listing = [];
page.on("request", (r) => { if (/\/library\/sections\/\d+\/all/.test(r.url())) listing.push(r.url()); });
const _desc = (sel) => page.evaluate((sel) => {
  const root = document.querySelector(sel); if (!root) return "(none)";
  const d = (n, k = 0) => k > 9 ? "" : `${"  ".repeat(k)}<${n.tagName.toLowerCase()}${["role","aria-label","aria-haspopup","aria-checked","data-testid"].map(a => n.getAttribute(a) ? ` ${a}="${n.getAttribute(a).slice(0,50)}"` : "").join("")}>${n.children.length ? "" : " " + (n.textContent || "").trim().slice(0, 40)}\n` + [...n.children].map(c => d(c, k + 1)).join("");
  return d(root);
}, sel);
const lib = `http://127.0.0.1:32400/web/index.html#!/media/${MID}/com.plexapp.plugins.library?source=1&pivot=library`;
await page.goto(lib, { waitUntil: "load" }); await page.waitForTimeout(8000);
const finish = page.getByText("Finish Setup"); if (await finish.count()) { await finish.first().click(); await page.waitForTimeout(3000); await page.goto(lib); await page.waitForTimeout(5000); }
const dismiss = page.getByText("Don't show this again"); if (await dismiss.count()) { await dismiss.first().click(); await page.waitForTimeout(3000); }
console.log("URL:", page.url().replace(MID, "<MID>"));
const card = page.locator('[data-testid="cellItem"]').nth(2);
await card.hover(); await page.waitForTimeout(500);
await card.locator('button[aria-label="More Actions"]').click(); await page.waitForTimeout(1000);
console.log("CARD MENU ANCESTRY:\n" + await page.evaluate(() => {
  const el = [...document.querySelectorAll("*")].find((n) => n.children.length === 0 && n.textContent.trim() === "Play Next");
  const lines = []; let n = el;
  for (let i = 0; n && i < 9; i++, n = n.parentElement) lines.push(`${n.tagName.toLowerCase()} ${["role","aria-label","aria-orientation","data-testid","tabindex","class"].map(a => n.getAttribute(a) ? `${a}="${n.getAttribute(a).slice(0,45)}"` : "").filter(Boolean).join(" ")} children=${n.children.length}`);
  return lines.join("\n");
}));
await page.screenshot({ path: out + "/ui4-menu.png" });
await page.keyboard.press("Escape"); await page.waitForTimeout(500);
await page.locator("button[aria-haspopup=true]", { hasText: /^By / }).first().click(); await page.waitForTimeout(1000);
console.log("SORT MENU ANCESTRY:\n" + await page.evaluate(() => {
  const el = [...document.querySelectorAll("*")].find((n) => n.children.length === 0 && n.textContent.trim() === "Year");
  const lines = []; let n = el;
  for (let i = 0; n && i < 6; i++, n = n.parentElement) lines.push(`${n.tagName.toLowerCase()} ${["role","aria-label","aria-checked","data-testid","class"].map(a => n.getAttribute(a) ? `${a}="${n.getAttribute(a).slice(0,45)}"` : "").filter(Boolean).join(" ")} children=${n.children.length}`);
  return lines.join("\n");
}));
listing.length = 0;
await page.getByRole("menuitem", { name: "Year", exact: true }).or(page.getByText("Year", { exact: true })).first().click(); await page.waitForTimeout(3000);
console.log("after sort LISTING:", listing.map(u => u.replace(/&X-Plex-[^&]+/g, "")).join("\n  "));
const keys = await page.$$eval('a[href*="%2Flibrary%2Fmetadata%2F"]', as => as.map(a => /metadata%2F(\d+)/.exec(a.getAttribute("href"))[1]));
console.log("DOM order after sort:", [...new Set(keys)].join(" "), "| button:", await page.locator("button[aria-haspopup=true]", { hasText: /^By / }).first().textContent());
await browser.close();
