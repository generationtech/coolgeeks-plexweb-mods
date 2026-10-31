/**
 * Page object for Plex Web. Every selector/label here is Plex-coupled; all
 * were verified against Plex Web 4.162.1 (PMS 1.43.5) in a live run. Keep
 * them in this file. Runtime-side DOM anchors live in
 * patches/play-from-here/plex-anchors.ts.
 */
import type { Page } from "@playwright/test";
import { PLEX_ANCHORS } from "../patches/play-from-here/plex-anchors";

export const UI = {
  /** One-time page of a new browser profile ("Plex Web Setup"). */
  finishSetup: "Finish Setup",
  /** Notice shown for an unclaimed server; dismissible. */
  dismissUnclaimed: "Don't show this again",
  /** Sort popup button (grid and Detail View); its text is the current sort ("By Title"). */
  sortButton: { css: 'button[aria-haspopup="true"]', text: /^By / },
  /** Table View has no sort popup: its column headers ("Title", "Year") are links that sort. */
  /** View-style popup ("Grid View", "Detail View", "Table View"). */
  viewButton: '[data-testid="toolbarView"]',
  /** A poster card in a grid. */
  card: '[data-testid="cellItem"]',
  /** The "..." button of a card or row (rows show it on hover). */
  moreButton: 'button[aria-label="More Actions"]',
  /** Something only present while the player is up. */
  player: "video",
  /** Player controls (aria-labels). */
  playerPause: "Pause",
  playerNext: "Next",
  playerPrevious: "Previous",
  playFromHere: '[data-plexweb-mods="play-from-here"]',
} as const;

const itemLinkSelector = PLEX_ANCHORS.dom.itemLinkSelector.value;
const itemLinkFor = (rk: string) => `a[href*="%2Flibrary%2Fmetadata%2F${rk}&"], a[href$="%2Flibrary%2Fmetadata%2F${rk}"]`;
const itemKeyPattern = PLEX_ANCHORS.dom.itemKeyPattern.value;

export class PlexWeb {
  constructor(readonly page: Page) {}

  libraryUrl(baseUrl: string, machineIdentifier: string, sectionId: string): string {
    return `${baseUrl}/web/index.html#!/media/${machineIdentifier}/com.plexapp.plugins.library?source=${sectionId}&pivot=library`;
  }

  detailsUrl(baseUrl: string, machineIdentifier: string, ratingKey: string): string {
    return `${baseUrl}/web/index.html#!/server/${machineIdentifier}/details?key=${encodeURIComponent(`/library/metadata/${ratingKey}`)}`;
  }

  /** Opens a page, getting past first-run pages on a fresh profile; waits for item links. */
  async open(url: string): Promise<void> {
    await this.page.goto(url);
    const setup = this.page.getByText(UI.finishSetup, { exact: true });
    const items = this.page.locator(itemLinkSelector).first();
    const dismiss = this.page.getByText(UI.dismissUnclaimed);
    await setup.or(items).or(dismiss).first().waitFor({ timeout: 45_000 });
    if (await setup.count()) {
      await setup.first().click();
      await this.page.waitForURL((u) => !u.hash.includes("client-setup"));
      await this.page.goto(url);
    }
    await dismiss.or(items).first().waitFor({ timeout: 45_000 });
    if (await dismiss.count()) await dismiss.first().click();
    await items.waitFor({ timeout: 45_000 });
  }

  async waitForRuntime(): Promise<void> {
    await this.page.waitForFunction(() => !!(window as any).__plexwebMods, undefined, { timeout: 30_000 });
  }

  async applySort(label: string): Promise<void> {
    const popup = this.page.locator(UI.sortButton.css, { hasText: UI.sortButton.text }).first();
    if (await popup.isVisible().catch(() => false)) {
      await popup.click();
      await this.page.getByRole("menuitem", { name: label, exact: true }).first().click();
    } else {
      await this.page.getByRole("link", { name: label, exact: true }).first().click(); // Table View column header
    }
  }

  async setViewStyle(name: "Grid View" | "Detail View" | "Table View"): Promise<void> {
    await this.page.locator(UI.viewButton).click();
    await this.page.getByRole("menuitem", { name: new RegExp(`^${name}`) }).first().click();
  }

  /** Rating keys of the items currently in the DOM, in document order. */
  async visibleRatingKeys(): Promise<string[]> {
    return this.page.$$eval(
      itemLinkSelector,
      (links, src) => {
        const re = new RegExp(src);
        const keys: string[] = [];
        for (const a of links) {
          const m = re.exec(a.getAttribute("href") ?? "");
          if (m?.[1] && !keys.includes(m[1])) keys.push(m[1]);
        }
        return keys;
      },
      itemKeyPattern.source,
    );
  }

  /** Scrolls the list until the item's link is rendered (Plex Web renders long lists lazily). */
  async revealItem(ratingKey: string): Promise<void> {
    const link = this.page.locator(itemLinkFor(ratingKey)).first();
    const { width, height } = this.page.viewportSize() ?? { width: 1280, height: 720 };
    for (let i = 0; i < 80 && !(await link.isVisible().catch(() => false)); i++) {
      if ((await link.count()) > 0) {
        await link.scrollIntoViewIfNeeded().catch(() => {});
        continue;
      }
      await this.page.mouse.move(width * 0.6, height * 0.6);
      await this.page.mouse.wheel(0, height * 0.5);
      await this.page.waitForTimeout(250);
    }
    await link.waitFor({ state: "visible", timeout: 5_000 });
  }

  /** Opens the "..." menu of the card/row for `ratingKey` (any view style) and clicks "Play from here". */
  async playFromHere(ratingKey: string): Promise<void> {
    await this.revealItem(ratingKey);
    const link = this.page.locator(itemLinkFor(ratingKey)).first();
    await link.hover();
    const row = link.locator(`xpath=ancestor::*[.//button[@aria-label="More Actions"]][1]`);
    await row.locator(UI.moreButton).first().click();
    await this.page.locator(UI.playFromHere).click();
  }

  /** Clicks a player control and waits for Plex Web to report a different item in /:/timeline. */
  async playerStep(control: string, currentRatingKey: () => string | undefined): Promise<string | undefined> {
    const before = currentRatingKey();
    await this.page.getByRole("button", { name: control, exact: true }).click();
    for (let i = 0; i < 60 && currentRatingKey() === before; i++) await this.page.waitForTimeout(100);
    return currentRatingKey();
  }
}
