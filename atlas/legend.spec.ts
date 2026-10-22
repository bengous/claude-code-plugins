import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { planOf } from "./folder.ts";
import { graphOf, isZoneRef } from "./graph.ts";
import { legendHtml, legendKeys } from "./legend.ts";
import type { Edge, Plan } from "./model.ts";
import { WORDS } from "./words.ts";

const PLAN = await planOf(join(import.meta.dir, "fixtures", "sample"));

const keysOf = (plan: Plan): ReturnType<typeof legendKeys> => legendKeys(graphOf(plan));

// Every leaves' arrow dashed, but orders → db of the given kind.
const dashedBut = (kind: "dash" | "deny"): Plan => ({
  ...PLAN,
  edges: PLAN.edges.map((e): Edge =>
    isZoneRef(e.from) || isZoneRef(e.to)
      ? e
      : { ...e, kind: e.from === "orders" && e.to === "db" ? kind : "dash" },
  ),
});

describe("legendKeys", () => {
  test("the sample's legend has a line for each kind it uses, and none for a refused arrow", () => {
    expect(keysOf(PLAN)).toEqual(["flow", "dash", "coupled", "outside", "open"]);
  });

  test("a refused arrow adds its line, in legend order", () => {
    const edges = PLAN.edges.map((e) =>
      e.from === "web" && e.to === "orders" ? { ...e, kind: "deny" as const } : e,
    );

    expect(keysOf({ ...PLAN, edges })).toEqual([
      "flow",
      "dash",
      "deny",
      "coupled",
      "outside",
      "open",
    ]);
  });

  test("a link that names an overview arrow draws nothing, so its kind adds no line", () => {
    const edges = [
      ...PLAN.edges,
      { from: "z:app", to: "z:data", label: "x", kind: "deny" as const },
    ];

    expect(keysOf({ ...PLAN, edges })).not.toContain("deny");
  });

  test("an overview arrow whose leaves' arrows differ in kind is drawn plain, and adds the flow line", () => {
    expect(keysOf(dashedBut("dash"))).toEqual(["dash", "coupled", "outside", "open"]);
    expect(keysOf(dashedBut("deny"))).toEqual([
      "flow",
      "dash",
      "deny",
      "coupled",
      "outside",
      "open",
    ]);
  });

  test("a map without couplings, outside nodes, open points or dashed links shows flows only", () => {
    const gone = new Set(["browser", "email"]);

    const plain: Plan = {
      ...PLAN,
      zones: PLAN.zones.filter((z) => z.ext !== true),
      nodes: PLAN.nodes
        .filter((n) => !gone.has(n.id))
        .map((n) => ({ ...n, info: { ...n.info, open: [] }, couples: [] })),
      edges: PLAN.edges.filter((e) => e.kind === undefined && !gone.has(e.from) && !gone.has(e.to)),
    };

    expect(keysOf(plain)).toEqual(["flow"]);
  });
});

describe("legendHtml", () => {
  test("one line per key, its glyph then its label, escaped", () => {
    expect(legendHtml(["deny", "open"], { ...WORDS.en.legend, deny: "<refused>" })).toBe(
      [
        '<span><svg viewBox="0 0 26 8" aria-hidden="true"><line x1="0" y1="4" x2="26" y2="4" stroke="var(--deny)" stroke-width="2"/></svg>&lt;refused&gt;</span>',
        '<span><svg viewBox="0 0 26 12" aria-hidden="true" style="height:12px"><circle cx="13" cy="6" r="4.5" fill="var(--open)"/></svg>open point</span>',
      ].join(""),
    );
  });
});
