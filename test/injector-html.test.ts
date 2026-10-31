import { describe, expect, it } from "vitest";
import { BEGIN_MARKER, END_MARKER, hasInjection, injectedVersion, injectTag, lineDiff, removeInjection, renderTag } from "../injector/html";

const PLEX_LIKE = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <!-- <script src="commented-out.js"></script> -->
    <title>Plex</title>
    <script>window.config = {}</script>
    <script defer src="js/main.js"></script>
  </head>
  <body></body>
</html>
`;

const tag = (v = "abc123def456") => renderTag({ version: v, chunkGlobals: ["webpackChunkplex"] });

describe("renderTag", () => {
  it("renders a marked, cache-busted script tag with config attributes", () => {
    expect(renderTag({ version: "abc", chunkGlobals: ["a", "b"], banner: false, reportDelayMs: 5000.7, options: { "pfh-companion": "off" } })).toBe(
      `${BEGIN_MARKER}<script src="plexweb-mods.js?v=abc" data-chunk-globals="a,b" data-banner="off" data-report-delay-ms="5000" data-opt-pfh-companion="off"></script>${END_MARKER}`,
    );
  });

  it("escapes attribute values and validates names", () => {
    expect(renderTag({ version: "v", options: { x: '"><img>' } })).toContain('data-opt-x="&quot;&gt;&lt;img&gt;"');
    expect(() => renderTag({ version: "v", options: { "Bad Name": "1" } })).toThrow(/invalid option name/);
    expect(() => renderTag({ version: "v?x" })).toThrow(/invalid version/);
  });
});

describe("injectTag / removeInjection", () => {
  it("inserts on its own line before the first real <script>, skipping comments", () => {
    const r = injectTag(PLEX_LIKE, tag());
    expect(r.position).toBe("before-first-script");
    const lines = r.html.split("\n");
    const at = lines.findIndex((l) => l.includes(BEGIN_MARKER));
    expect(lines[at]).toBe(`    ${tag()}`);
    expect(lines[at + 1]).toBe("    <script>window.config = {}</script>");
    expect(r.html.indexOf(BEGIN_MARKER)).toBeGreaterThan(r.html.indexOf("commented-out.js"));
  });

  it("inserts inline when the first script shares a line with other markup", () => {
    const r = injectTag("<html><head><title>x</title><script src=a.js></script></head></html>", tag());
    expect(r.html).toBe(`<html><head><title>x</title>${tag()}<script src=a.js></script></head></html>`);
  });

  it("falls back to the end of <head> when there is no script", () => {
    const r = injectTag("<html><head><title>x</title></head><body></body></html>", tag());
    expect(r.position).toBe("end-of-head");
    expect(r.html).toBe(`<html><head><title>x</title>${tag()}\n</head><body></body></html>`);
  });

  it("refuses to guess without <script> or </head>", () => {
    expect(() => injectTag("<p>hi</p>", tag())).toThrow(/refusing to guess/);
  });

  it("is idempotent and replaces an older version in place", () => {
    const once = injectTag(PLEX_LIKE, tag("v1")).html;
    expect(injectTag(once, tag("v1"))).toEqual({ html: once, changed: false, position: "replaced" });
    const updated = injectTag(once, tag("v2"));
    expect(updated.changed).toBe(true);
    expect(injectedVersion(updated.html)).toBe("v2");
    expect(updated.html.split(BEGIN_MARKER)).toHaveLength(2);
  });

  it("removal restores the original byte for byte", () => {
    for (const html of [PLEX_LIKE, "<html><head><title>x</title><script src=a.js></script></head></html>", "<html><head></head></html>"]) {
      const injected = injectTag(html, tag()).html;
      expect(hasInjection(injected)).toBe(true);
      expect(removeInjection(injected)).toBe(html);
    }
  });

  it("refuses unbalanced markers", () => {
    expect(() => removeInjection(`${BEGIN_MARKER}<script></script>`)).toThrow(/unbalanced/);
  });
});

describe("lineDiff", () => {
  it("shows only the changed region", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc")).toBe("@@ line 2 @@\n- b\n+ B");
    expect(lineDiff("same", "same")).toBe("(no changes)");
  });
});
