// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDomMenuIntegration, findItemForElement } from "../patches/play-from-here/dom-menu";
import { PLEX_ANCHORS } from "../patches/play-from-here/plex-anchors";

const { dom } = PLEX_ANCHORS;
const link = (rk: number) => `<a href="#!/server/test-machine-identifier/details?key=%2Flibrary%2Fmetadata%2F${rk}">t</a>`;

function grid() {
  document.body.innerHTML = `
    <div id="grid">
      <div class="card" id="c1"><div class="poster">${link(101)}</div><button class="more" id="m1">...</button></div>
      <div class="card" id="c2"><div class="poster">${link(102)}</div><button class="more" id="m2">...</button></div>
    </div>`;
}

function openMenu(labels = ["Play", "Play Next", "Add to Up Next", "Mark as Played"]) {
  const menu = document.createElement("div");
  menu.setAttribute("role", "menu");
  menu.innerHTML = labels.map((l, i) => `<div role="menuitem" id="mi${i}" tabindex="-1"><span class="icon"></span><span>${l}</span></div>`).join("");
  document.body.appendChild(menu);
  return menu;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("findItemForElement", () => {
  beforeEach(grid);

  it("finds the card's rating key from inside the card", () => {
    expect(findItemForElement(document.getElementById("m2"), dom.itemLinkSelector.value, dom.itemKeyPattern.value)).toEqual({ ratingKey: "102" });
  });

  it("returns null when it reaches a container with several items first", () => {
    expect(findItemForElement(document.getElementById("grid"), dom.itemLinkSelector.value, dom.itemKeyPattern.value)).toBeNull();
  });
});

describe("DOM menu integration", () => {
  let uninstall: () => void = () => {};
  afterEach(() => uninstall());

  function install(isAvailable = () => true) {
    const onSelect = vi.fn();
    uninstall = createDomMenuIntegration({
      doc: document,
      menuSelector: dom.menuSelector.value,
      menuItemSelector: dom.menuItemSelector.value,
      anchorLabels: dom.menuAnchorLabels.value,
      itemLinkSelector: dom.itemLinkSelector.value,
      itemKeyPattern: dom.itemKeyPattern.value,
    }).install({ isAvailable, onSelect });
    return onSelect;
  }

  it("inserts 'Play from here' after 'Play Next' for the card the menu was opened on", async () => {
    grid();
    const onSelect = install();
    document.getElementById("m2")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    const menu = openMenu();
    await flush();
    const labels = [...menu.querySelectorAll('[role="menuitem"]')].map((e) => e.textContent);
    expect(labels).toEqual(["Play", "Play Next", "Play from here", "Add to Up Next", "Mark as Played"]);
    const ours = menu.querySelector("[data-plexweb-mods]")!;
    expect(ours.id).toBe("");
    expect(ours.getAttribute("tabindex")).toBe("-1");
    const closed = vi.fn();
    menu.addEventListener("keydown", (e) => (e as KeyboardEvent).key === "Escape" && closed());
    (ours as HTMLElement).click();
    expect(onSelect).toHaveBeenCalledWith({ ratingKey: "102" });
    expect(closed).toHaveBeenCalled();
  });

  it("supports keyboard activation and does not duplicate the entry", async () => {
    grid();
    const onSelect = install();
    document.getElementById("m1")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    const menu = openMenu();
    await flush();
    menu.appendChild(document.createElement("span")); // re-render noise
    await flush();
    expect(menu.querySelectorAll("[data-plexweb-mods]")).toHaveLength(1);
    menu.querySelector("[data-plexweb-mods]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onSelect).toHaveBeenCalledWith({ ratingKey: "101" });
  });

  it("falls back to the second anchor label", async () => {
    grid();
    install();
    document.getElementById("m1")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    const menu = openMenu(["Play", "Add to Up Next"]);
    await flush();
    expect([...menu.children].map((e) => e.textContent)).toEqual(["Play", "Add to Up Next", "Play from here"]);
  });

  it.each([
    ["not available (not a listing)", () => false, true],
    ["no remembered card", () => true, false],
  ])("stays out of the menu when %s", async (_label, isAvailable, clickCard) => {
    grid();
    install(isAvailable);
    if (clickCard) document.getElementById("m1")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    const menu = openMenu();
    await flush();
    expect(menu.querySelector("[data-plexweb-mods]")).toBeNull();
  });

  it("ignores menus without an anchor label", async () => {
    grid();
    install();
    document.getElementById("m1")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    const menu = openMenu(["Edit", "Delete"]);
    await flush();
    expect(menu.querySelector("[data-plexweb-mods]")).toBeNull();
  });
});
