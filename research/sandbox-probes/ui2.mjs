import { createRequire } from "node:module";
const { chromium } = createRequire(new URL("../../package.json", import.meta.url))("@playwright/test");
const out = process.argv[2];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
const listing = [];
page.on("request", (r) => { if (/\/library\/sections\/\d+\/all/.test(r.url())) listing.push(r.url().replace(/X-Plex-Token=[^&]+/, "X-Plex-Token=REDACTED")); });
await page.goto("http://127.0.0.1:32400/web/index.html", { waitUntil: "load" });
await page.waitForTimeout(8000);
const finish = page.getByText("Finish Setup");
if (await finish.count()) { await finish.first().click(); await page.waitForTimeout(3000); }
console.log("after setup URL:", page.url());
await page.getByText("Test Movies").first().click();
await page.waitForTimeout(4000);
const dismiss = page.getByText("Don't show this again");
if (await dismiss.count()) { await dismiss.first().click(); await page.waitForTimeout(5000); }
console.log("library URL:", page.url());
console.log("listing requests:", listing.join("\n   "));
const links = await page.$$eval('a[href*="%2Flibrary%2Fmetadata%2F"]', (as) => as.map((a) => a.getAttribute("href")));
console.log("item links:", links.length, links.slice(0, 8));
await page.screenshot({ path: out + "/ui2-library.png" });
// structure of the first card
await page.screenshot({ path: out + "/ui2-library.png" }); console.log("TEXT:", (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, " ").slice(0, 300));
const card = await page.evaluate(() => {
  const a = document.querySelector('a[href*="%2Flibrary%2Fmetadata%2F"]');
  let el = a; for (let i = 0; i < 6 && el.parentElement; i++) el = el.parentElement;
  const desc = (n, d = 0) => d > 7 ? "" : `${"  ".repeat(d)}<${n.tagName.toLowerCase()}${["role","aria-label","data-testid","href"].map(k => n.getAttribute(k) ? ` ${k}="${n.getAttribute(k).slice(0,60)}"` : "").join("")}>\n` + [...n.children].map(c => desc(c, d + 1)).join("");
  return desc(el);
});
console.log("CARD STRUCTURE:\n" + card.slice(0, 3500));
const buttons = await page.$$eval("button[aria-label], [role=button][aria-label]", (bs) => [...new Set(bs.map((b) => b.getAttribute("aria-label") + " | testid=" + b.getAttribute("data-testid")))]);
console.log("BUTTONS:", buttons.slice(0, 60).join("\n  "));
await browser.close();
