/**
 * DOM-level menu integration: adds "Play from here" right after an existing
 * entry (e.g. "Play Next") whenever Plex Web opens an item context menu, and
 * identifies the item from the card the user opened the menu on.
 *
 * Plex-coupled only through the selectors/labels passed in (see
 * plex-anchors.ts). Needs no bundle patch.
 */
import type { MenuIntegration } from "./bindings";
import type { ItemRef } from "./playqueue";

export interface DomMenuOptions {
  doc: Document;
  menuSelector: string;
  menuItemSelector: string;
  anchorLabels: readonly string[];
  itemLinkSelector: string;
  itemKeyPattern: RegExp;
  label?: string;
  /** How long a remembered card stays valid for an opening menu. */
  targetTtlMs?: number;
  now?: () => number;
}

export const MENU_ITEM_MARKER = "data-plexweb-mods";
const MARKER_VALUE = "play-from-here";

const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/**
 * Walks up from `start` to the smallest ancestor that contains exactly one
 * distinct item key: that ancestor is the item's card/row. Stops as soon as
 * an ancestor contains several distinct keys (we reached the grid).
 */
export function findItemForElement(start: Element | null, itemLinkSelector: string, itemKeyPattern: RegExp, maxDepth = 20): ItemRef | null {
  let el: Element | null = start;
  for (let depth = 0; el && depth < maxDepth; depth++, el = el.parentElement) {
    const keys = new Set<string>();
    const links: Element[] = el.matches(itemLinkSelector) ? [el] : [];
    links.push(...Array.from(el.querySelectorAll(itemLinkSelector)));
    for (const link of links) {
      const m = itemKeyPattern.exec(link.getAttribute("href") ?? "");
      if (m?.[1]) keys.add(m[1]);
    }
    if (keys.size === 1) return { ratingKey: [...keys][0]! };
    if (keys.size > 1) return null;
  }
  return null;
}

function replaceLabel(root: Element, from: string, to: string): void {
  const walker = root.ownerDocument.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (norm(n.nodeValue) === from) {
      n.nodeValue = to;
      return;
    }
  }
  root.textContent = to;
}

export function createDomMenuIntegration(opts: DomMenuOptions): MenuIntegration {
  const label = opts.label ?? "Play from here";
  const ttl = opts.targetTtlMs ?? 15_000;
  const now = opts.now ?? Date.now;

  return {
    install({ isAvailable, onSelect }) {
      const { doc } = opts;
      let target: { item: ItemRef; at: number } | null = null;

      const remember = (ev: Event) => {
        const el = ev.target instanceof doc.defaultView!.Element ? (ev.target as Element) : null;
        if (!el || el.closest(`[${MENU_ITEM_MARKER}]`) || el.closest(opts.menuSelector)) return;
        const item = findItemForElement(el, opts.itemLinkSelector, opts.itemKeyPattern);
        if (item) target = { item, at: now() };
      };

      const decorate = (menu: Element) => {
        if (menu.querySelector(`[${MENU_ITEM_MARKER}="${MARKER_VALUE}"]`)) return;
        const items = Array.from(menu.querySelectorAll(opts.menuItemSelector));
        let anchor: Element | undefined;
        for (const l of opts.anchorLabels) {
          anchor = items.find((i) => norm(i.textContent) === l);
          if (anchor) break;
        }
        if (!anchor || !target || now() - target.at > ttl || !isAvailable()) return;
        const item = target.item;
        const clone = anchor.cloneNode(true) as Element;
        clone.removeAttribute("id");
        clone.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
        clone.setAttribute(MENU_ITEM_MARKER, MARKER_VALUE);
        replaceLabel(clone, norm(anchor.textContent), label);
        const activate = (ev: Event) => {
          ev.preventDefault();
          ev.stopPropagation();
          // Ask the menu to close the way a user would.
          const esc = { key: "Escape", code: "Escape", keyCode: 27, bubbles: true } as KeyboardEventInit;
          menu.dispatchEvent(new doc.defaultView!.KeyboardEvent("keydown", esc));
          onSelect(item);
        };
        clone.addEventListener("click", activate, true);
        clone.addEventListener(
          "keydown",
          (ev) => {
            const k = (ev as KeyboardEvent).key;
            if (k === "Enter" || k === " ") activate(ev);
          },
          true,
        );
        anchor.after(clone);
      };

      const scan = (node: Node) => {
        if (!(node instanceof doc.defaultView!.Element)) return;
        const el = node as Element;
        if (el.matches(opts.menuSelector)) decorate(el);
        el.querySelectorAll(opts.menuSelector).forEach(decorate);
        // menu items rendered into an already-present menu container
        const menu = el.closest(opts.menuSelector);
        if (menu) decorate(menu);
      };

      const observer = new doc.defaultView!.MutationObserver((records) => {
        for (const r of records) r.addedNodes.forEach(scan);
      });
      observer.observe(doc.documentElement, { childList: true, subtree: true });
      for (const type of ["pointerdown", "mousedown", "contextmenu", "keydown"]) doc.addEventListener(type, remember, true);

      return () => {
        observer.disconnect();
        for (const type of ["pointerdown", "mousedown", "contextmenu", "keydown"]) doc.removeEventListener(type, remember, true);
      };
    },
  };
}
