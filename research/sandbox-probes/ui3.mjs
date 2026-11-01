import { createRequire } from "node:module";
const { chromium } = createRequire(new URL("../../package.json", import.meta.url))("@playwright/test");
const out = process.argv[2];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
const MID = (await (await fetch("http://127.0.0.1:32400/identity", { headers: { Accept: "application/json" } })).json()).MediaContainer.machineIdentifier;
const listing = [];
page.on("request", (r) => { if (/\/library\/sections\/\d+\/all/.test(r.url())) listing.push(r.url()); });
const desc = (sel) => page.evaluate((sel) => {
  const root = typeof sel === "string" ? document.querySelector(sel) : null; if (!root) return "(none)";
  const d = (n, k = 0) => k > 9 ? "" : `${"  ".repeat(k)}<${n.tagName.toLowerCase()}${["role","aria-label","aria-haspopup","data-testid","class"].map(a => n.getAttribute(a) ? ` ${a}="${n.getAttribute(a).slice(0,50)}"` : "").join("")}>${n.children.length ? "" : " " + (n.textContent || "").trim().slice(0, 40)}\n` + [...n.children].map(c => d(c, k + 1)).join("");
  return d(root);
}, sel);
await page.goto("http://127.0.0.1:32400/web/index.html#!/media/"+MID+"/com.plexapp.plugins.library?source=1", { waitUntil: "load" });
await page.waitForTimeout(8000);
const finish = page.getByText("Finish Setup"); if (await finish.count()) { await finish.first().click(); await page.waitForTimeout(3000); }
await page.goto("http://127.0.0.1:32400/web/index.html#!/media/"+MID+"/com.plexapp.plugins.library?source=1"); await page.waitForTimeout(5000);
const dismiss = page.getByText("Don't show this again"); if (await dismiss.count()) { await dismiss.first().click(); await page.waitForTimeout(2000); }
console.log("URL0:", page.url());
await page.getByText("Library", { exact: true }).first().click();
await page.waitForTimeout(6000);
console.log("URL1:", page.url());
console.log("LISTING:", listing.map(u => u.replace(/X-Plex-Token=[^&]+/, "TOKEN")).join("\n  "));
await page.screenshot({ path: out + "/ui3-grid.png" });
const keys = await page.$$eval('a[href*="%2Flibrary%2Fmetadata%2F"]', as => as.map(a => /metadata%2F(\d+)/.exec(a.getAttribute("href"))[1]));
console.log("DOM key order:", [...new Set(keys)].join(" "));
// sort control
const sortish = await page.$$eval("button", bs => bs.map(b => `${b.getAttribute("aria-label")}|${b.getAttribute("data-testid")}|${b.getAttribute("aria-haspopup")}|${(b.textContent||"").trim().slice(0,30)}`).filter(s => !/^null\|null\|null\|$/.test(s)));
console.log("BUTTONS:\n  " + sortish.join("\n  "));
// hover first card, find buttons inside
const card = page.locator('[data-testid="cellItem"]').first();
await card.hover(); await page.waitForTimeout(800);
console.log("CARD HOVER:\n" + await desc('[data-testid="cellItem"]'));
await card.locator('button[aria-label="More Actions"]').click(); await page.waitForTimeout(1000);
const menuSel = await page.evaluate(() => { const m = document.querySelector('[role="menu"]'); return m ? (m.getAttribute("data-testid") || "role=menu") : "NO role=menu"; });
console.log("MENU:", menuSel);
console.log(await desc('[role="menu"]'));
await page.screenshot({ path: out + "/ui3-menu.png" });
await page.keyboard.press("Escape"); await page.waitForTimeout(500);
await page.locator("button", { hasText: "By Title" }).first().click(); await page.waitForTimeout(1000);
console.log("SORT MENU:\n" + await desc('[role="menu"]'));
listing.length = 0;
await page.locator('[role="menu"] >> text=Year').first().click(); await page.waitForTimeout(3000);
console.log("after sort LISTING:", listing.map(u => u.replace(/&X-Plex-[^&]+/g, "")).join("\n  "));
const keys2 = await page.$$eval('a[href*="%2Flibrary%2Fmetadata%2F"]', as => as.map(a => /metadata%2F(\d+)/.exec(a.getAttribute("href"))[1]));
console.log("DOM key order after sort:", [...new Set(keys2)].join(" "), "| sort button:", await page.locator("button[aria-haspopup=true]", { hasText: /^By / }).first().textContent());
await browser.close();
