import { describe, expect, it } from "vitest";
import { AnchorResolutionError, assertResolved, formatReport, PatchSession } from "../runtime/engine";
import type { PluginDef } from "../runtime/types";

const plugin = (patches: PluginDef["patches"], name = "demo"): PluginDef => ({ name, description: "test", patches });

describe("PatchSession.transform", () => {
  it("selects a module only when ALL find anchors occur", () => {
    const s = new PatchSession([
      plugin([{ id: "demo/a", find: ["alpha", /be+ta/], replacements: [{ match: "alpha", replace: "ALPHA" }] }]),
    ]);
    expect(s.transform("1", "alpha only").changed).toBe(false);
    const r = s.transform("2", "alpha and beeeta");
    expect(r.code).toBe("ALPHA and beeeta");
    expect(r.applied).toEqual(["demo/a"]);
  });

  it("string replacement replaces the first occurrence; /g regex replaces all", () => {
    const s = new PatchSession([
      plugin([
        { id: "demo/first", find: "x", replacements: [{ match: "x", replace: "y" }] },
        { id: "demo/all", find: "q", replacements: [{ match: /q/g, replace: "Q" }] },
      ]),
    ]);
    expect(s.transform("1", "x x q q").code).toBe("y x Q Q");
  });

  it("supports capture groups and $& in replacements", () => {
    const s = new PatchSession([
      plugin([{ id: "demo/g", find: "label:", replacements: [{ match: /label:"([^"]+)"/, replace: 'label:"[$1]",orig:"$&"' }] }]),
    ]);
    expect(s.transform("1", 'label:"Play"').code).toBe('label:"[Play]",orig:"label:"Play""');
  });

  it("expands $self in string and function replacements", () => {
    const s = new PatchSession([
      plugin(
        [
          { id: "p/s", find: "A", replacements: [{ match: "A", replace: "$self.a()" }] },
          { id: "p/f", find: "B", replacements: [{ match: "B", replace: () => "$self.b()" }] },
        ],
        "my-plugin",
      ),
    ]);
    expect(s.transform("1", "A B").code).toBe(
      'globalThis.__plexwebMods.plugins["my-plugin"].a() globalThis.__plexwebMods.plugins["my-plugin"].b()',
    );
  });

  it("applies replacements atomically and reports the exact missing anchor", () => {
    const issues: string[] = [];
    const s = new PatchSession(
      [
        plugin([
          {
            id: "demo/atomic",
            find: "anchor",
            replacements: [
              { match: "anchor", replace: "CHANGED" },
              { match: "missing-bit", replace: "nope" },
            ],
          },
        ]),
      ],
      { onIssue: (i) => issues.push(i.code) },
    );
    const r = s.transform("42", "anchor here");
    expect(r.changed).toBe(false);
    expect(r.code).toBe("anchor here");
    expect(issues).toEqual(["REPLACEMENT_NO_MATCH"]);
    const rep = s.report();
    expect(rep.ok).toBe(false);
    expect(rep.failures[0]!.message).toMatch(/module 42 matched the find anchors, but replacement #1 anchor "missing-bit"/);
    expect(rep.entries[0]!.status).toBe("failed");
  });

  it("later replacements see the output of earlier ones", () => {
    const s = new PatchSession([
      plugin([{ id: "d/chain", find: "a", replacements: [{ match: "a", replace: "b" }, { match: "bb", replace: "c" }] }]),
    ]);
    expect(s.transform("1", "ab").code).toBe("c");
  });

  it("reverts a patch whose output fails validation (COMPILE_ERROR)", () => {
    const s = new PatchSession([
      plugin([
        { id: "d/bad", find: "ok", replacements: [{ match: "ok", replace: "ok(" }] },
        { id: "d/good", find: "fine", replacements: [{ match: "fine", replace: "FINE" }] },
      ]),
    ]);
    const validate = (code: string) => (code.includes("(") ? new Error("unbalanced") : null);
    const r = s.transform("7", "ok fine", validate);
    expect(r.code).toBe("ok FINE");
    expect(r.issues.map((i) => i.code)).toEqual(["COMPILE_ERROR"]);
    expect(r.issues[0]!.message).toMatch(/\[d\/bad\] COMPILE_ERROR: .*module 7.*unbalanced/);
  });

  it("flags ambiguous finds unless all: true", () => {
    const one = new PatchSession([plugin([{ id: "d/one", find: "dup", replacements: [{ match: "dup", replace: "X" }] }])]);
    expect(one.transform("1", "dup").changed).toBe(true);
    const second = one.transform("2", "dup");
    expect(second.changed).toBe(false);
    expect(second.issues[0]!.code).toBe("FIND_AMBIGUOUS");
    expect(second.issues[0]!.message).toMatch(/matched more than one module \(1, 2\)/);

    const many = new PatchSession([plugin([{ id: "d/many", all: true, find: "dup", replacements: [{ match: "dup", replace: "X" }] }])]);
    expect(many.transform("1", "dup").changed).toBe(true);
    expect(many.transform("2", "dup").changed).toBe(true);
    expect(many.report().ok).toBe(true);
  });

  it("re-registering the same module id is not ambiguity", () => {
    const s = new PatchSession([plugin([{ id: "d/x", find: "z", replacements: [{ match: "z", replace: "Z" }] }])]);
    s.transform("1", "z");
    expect(s.transform("1", "z").issues).toEqual([]);
  });

  it("returns capture points for onExports patches", () => {
    const seen: unknown[] = [];
    const s = new PatchSession([plugin([{ id: "d/cap", find: "exportsHere", onExports: (e) => void seen.push(e) }])]);
    const r = s.transform("9", "exportsHere");
    expect(r.changed).toBe(false);
    expect(r.captures).toHaveLength(1);
    r.captures[0]!.run({ hello: 1 }, "9");
    expect(seen).toEqual([{ hello: 1 }]);
  });

  it("reports onExports shape mismatches and throws", () => {
    const s = new PatchSession([
      plugin([
        { id: "d/shape", find: "m", onExports: () => false },
        { id: "d/throw", find: "m", onExports: () => { throw new Error("boom"); } },
      ]),
    ]);
    for (const c of s.transform("3", "m").captures) c.run({}, "3");
    const codes = s.report().failures.map((f) => f.code);
    expect(codes).toEqual(["EXPORTS_UNRECOGNIZED", "EXPORTS_HANDLER_ERROR"]);
  });

  it("rejects bad definitions early", () => {
    expect(() => new PatchSession([plugin([{ id: "x", find: [], replacements: [{ match: "a", replace: "b" }] }])])).toThrow(/no find anchors/);
    expect(() => new PatchSession([plugin([{ id: "x", find: "a" }])])).toThrow(/neither replacements nor onExports/);
    expect(
      () =>
        new PatchSession([
          plugin([
            { id: "x", find: "a", onExports: () => {} },
            { id: "x", find: "b", onExports: () => {} },
          ]),
        ]),
    ).toThrow(/duplicate patch id/);
  });
});

describe("PatchSession.report", () => {
  const defs = () =>
    new PatchSession([
      plugin([
        { id: "d/req", find: ["never-there", "also-missing"], replacements: [{ match: "x", replace: "y" }] },
        { id: "d/opt", optional: true, find: "nope", onExports: () => {} },
        { id: "d/lazy", lazy: true, find: "later", onExports: () => {} },
        { id: "d/split", find: ["left", "right"], onExports: () => {} },
      ]),
    ]);

  it("interim report treats unseen anchors as pending", () => {
    const s = defs();
    s.transform("1", "nothing");
    const r = s.report();
    expect(r.ok).toBe(true);
    expect(r.entries.map((e) => e.status)).toEqual(["pending", "pending", "pending", "pending"]);
  });

  it("final report fails loudly and specifically for each unresolved anchor", () => {
    const s = defs();
    s.transform("1", "left");
    s.transform("2", "right");
    const r = s.report({ final: true });
    expect(r.ok).toBe(false);
    const msgs = r.failures.map((f) => f.message);
    expect(msgs[0]).toBe(
      '[d/req] FIND_UNRESOLVED: find anchor(s) "never-there", "also-missing" occurred in no module (scanned 2 modules).',
    );
    expect(msgs[1]).toMatch(/\[d\/split\] FIND_UNRESOLVED: each find anchor occurred somewhere, but never all in the same module/);
    expect(r.warnings.map((w) => w.patchId)).toEqual(["d/opt"]);
    // lazy patches only fail when lazyIsFinal (preflight)
    expect(r.failures.some((f) => f.patchId === "d/lazy")).toBe(false);
    expect(s.report({ final: true, lazyIsFinal: true }).failures.some((f) => f.patchId === "d/lazy")).toBe(true);
  });

  it("records which modules each anchor resolved in", () => {
    const s = new PatchSession([plugin([{ id: "d/a", find: "k", replacements: [{ match: "k", replace: "K" }] }])]);
    s.transform("10", "k");
    const [find, rep] = s.report({ final: true }).entries[0]!.anchors;
    expect(find).toMatchObject({ kind: "find", hits: 1, modules: ["10"] });
    expect(rep).toMatchObject({ kind: "replacement", hits: 1, modules: ["10"] });
  });

  it("formatReport and assertResolved name the failing anchor", () => {
    const s = defs();
    const r = s.report({ final: true });
    const text = formatReport(r);
    expect(text).toMatch(/FAIL d\/req \(required\)/);
    expect(text).toMatch(/find\[0\] "never-there" -> not resolved/);
    expect(text).toMatch(/WARN d\/opt \(optional\)/);
    expect(() => assertResolved(r)).toThrow(AnchorResolutionError);
    expect(() => assertResolved(r)).toThrow(/\[d\/req\] FIND_UNRESOLVED/);
  });
});
