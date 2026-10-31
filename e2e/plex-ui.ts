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
  /** Sort popup button on a library grid; its text is the current sort ("By Title"). */
  sortButton: { css: 'button[aria-haspopup="true"]', text: /^By / },
  /** A poster card in the grid. */
  card: '[data-testid="cellItem"]',
  /** The card's "..." button. */
  moreButton: 'button[aria-label="More Actions"]',
  /** Something only present while the player is up. */
  player: "video",
  playFromHere: '[data-plexweb-mods="play-from-here"]',
} as const;

const itemLinkSelector = PLEX_ANCHORS.dom.itemLinkSelector.value;
const itemKeyPattern = PLEX_ANCHORS.dom.itemKeyPattern.value;

export class PlexWeb {
  constructor(readonly page: Page) {}

  libraryUrl(baseUrl: string, machineIdentifier: string, sectionId: string): string {
    return `${baseUrl}/web/index.html#!/media/${machineIdentifier}/com.plexapp.plugins.library?source=${sectionId}&pivot=library`;
  }

  /** Opens the library grid, getting past first-run pages on a fresh profile. */
  async openLibrary(url: string): Promise<void> {
    await this.page.goto(url);
    const setup = this.page.getByText(UI.finishSetup, { exact: true });
    const grid = this.page.locator(UI.card).first();
    await setup.or(grid).or(this.page.getByText(UI.dismissUnclaimed)).first().waitFor({ timeout: 45_000 });
    if (await setup.count()) {
      await setup.first().click();
      await this.page.waitForURL((u) => !u.hash.includes("client-setup"));
      await this.page.goto(url);
    }
    const dismiss = this.page.getByText(UI.dismissUnclaimed);
    await dismiss.or(grid).first().waitFor({ timeout: 45_000 });
    if (await dismiss.count()) await dismiss.first().click();
    await grid.waitFor({ timeout: 45_000 });
  }

  async waitForRuntime(): Promise<void> {
    await this.page.waitForFunction(() => !!(window as any).__plexwebMods, undefined, { timeout: 30_000 });
  }

  async applySort(label: string): Promise<void> {
    await this.page.locator(UI.sortButton.css, { hasText: UI.sortButton.text }).first().click();
    await this.page.getByRole("menuitem", { name: label, exact: true }).first().click();
  }

  /** Rating keys of the poster cards currently in the DOM, in document order. */
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

  /** Opens the "..." menu of the card for `ratingKey` and clicks "Play from here". */
  async playFromHere(ratingKey: string): Promise<void> {
    const card = this.page.locator(UI.card).filter({ has: this.page.locator(`a[href*="%2Flibrary%2Fmetadata%2F${ratingKey}&"], a[href$="%2Flibrary%2Fmetadata%2F${ratingKey}"]`) }).first();
    await card.scrollIntoViewIfNeeded();
    await card.hover();
    await card.locator(UI.moreButton).click();
    await this.page.locator(UI.playFromHere).click();
  }
}
