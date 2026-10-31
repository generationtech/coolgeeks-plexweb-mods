/**
 * DOM-level menu integration: adds "Play from here" right after an existing
 * entry (e.g. "Play Next") whenever Plex Web renders an item menu, and
 * identifies the item from the card the user opened the menu on.
 *
 * Plex-coupled only through the selectors/labels passed in (see
 * plex-anchors.ts). Needs no bundle patch.
 */
import type { MenuIntegration } from "./bindings";
import type { ItemRef } from "./playqueue";

export interface DomMenuOptions {
  doc: Document;
  /** Menu entries; the menu is the parent element of the anchor entry. */
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
        if (!el || el.closest(`[${MENU_ITEM_MARKER}]`) || el.closest(opts.menuItemSelector)) return;
        const item = findItemForElement(el, opts.itemLinkSelector, opts.itemKeyPattern);
        if (item) target = { item, at: now() };
      };

      const isAnchor = (el: Element) => opts.anchorLabels.includes(norm(el.textContent));

      /** Inserts our entry after `anchor` (an existing entry such as "Play Next"). */
      const decorate = (anchor: Element) => {
        const menu = anchor.parentElement;
        if (!menu || menu.querySelector(`:scope > [${MENU_ITEM_MARKER}="${MARKER_VALUE}"]`)) return;
        // Prefer the first label in anchorLabels when several are present.
        const siblings = Array.from(menu.children).filter((c) => c.matches(opts.menuItemSelector));
        for (const l of opts.anchorLabels) {
          const first = siblings.find((i) => norm(i.textContent) === l);
          if (first) {
            if (first !== anchor) return decorate(first);
            break;
          }
        }
        if (!target || now() - target.at > ttl || !isAvailable()) return;
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
        const items: Element[] = el.matches(opts.menuItemSelector) ? [el] : Array.from(el.querySelectorAll(opts.menuItemSelector));
        const own = el.closest(opts.menuItemSelector);
        if (own && !items.includes(own)) items.push(own); // text rendered into an existing entry
        for (const i of items) if (!i.hasAttribute(MENU_ITEM_MARKER) && isAnchor(i)) decorate(i);
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
