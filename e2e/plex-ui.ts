/**
 * Page object for Plex Web. Every selector/label here is Plex-coupled and
 * UNVERIFIED until the first real e2e run (BACKLOG B6). Keep them all in this
 * file. Runtime-side DOM anchors live in patches/play-from-here/plex-anchors.ts.
 */
import type { Page } from "@playwright/test";
import { PLEX_ANCHORS } from "../patches/play-from-here/plex-anchors";

export const UI = {
  /** Button that opens the sort menu on a library listing (shows the current sort). */
  sortButton: '[data-testid="sortButton"], button[aria-label*="Sort" i]',
  /** Entries of the opened sort menu. */
  sortMenuItem: (label: string) => `[role="menuitem"]:has-text("${label}"), [role="menuitemradio"]:has-text("${label}")`,
  /** "More" (...) button inside a poster card. */
  moreButton: 'button[aria-label*="More" i], [data-testid="moreButton"]',
  /** Something only visible while the player is open. */
  player: '[data-testid="videoPlayer"], [class*="Player"] video, video',
  playFromHere: '[data-plexweb-mods="play-from-here"]',
} as const;

const itemLinkSelector = PLEX_ANCHORS.dom.itemLinkSelector.value;
const itemKeyPattern = PLEX_ANCHORS.dom.itemKeyPattern.value;

export class PlexWeb {
  constructor(readonly page: Page) {}

  libraryUrl(baseUrl: string, machineIdentifier: string, sectionId: string): string {
    return `${baseUrl}/web/index.html#!/media/${machineIdentifier}/com.plexapp.plugins.library?source=${sectionId}`;
  }

  async waitForRuntime(): Promise<void> {
    await this.page.waitForFunction(() => !!(window as any).__plexwebMods, undefined, { timeout: 30_000 });
  }

  async applySort(label: string): Promise<void> {
    await this.page.locator(UI.sortButton).first().click();
    await this.page.locator(UI.sortMenuItem(label)).first().click();
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
          if (m?.[1] && keys[keys.length - 1] !== m[1] && !keys.includes(m[1])) keys.push(m[1]);
        }
        return keys;
      },
      itemKeyPattern.source,
    );
  }

  /** Opens the "more" menu of the card for `ratingKey` and clicks "Play from here". */
  async playFromHere(ratingKey: string): Promise<void> {
    const link = this.page.locator(`${itemLinkSelector}[href*="%2Flibrary%2Fmetadata%2F${ratingKey}"]`).first();
    await link.scrollIntoViewIfNeeded();
    await link.hover();
    // the card is the closest ancestor holding a "more" button
    const card = link.locator(`xpath=ancestor::*[.//*[self::button]][1]`);
    await card.locator(UI.moreButton).first().click();
    await this.page.locator(UI.playFromHere).click();
  }
}
