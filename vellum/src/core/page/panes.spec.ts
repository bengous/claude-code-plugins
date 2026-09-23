import { describe, expect, test } from "bun:test";

import type { Pane, ShownPanel } from "./panes.ts";
import { DOCS_PANE, guttersOf, PANE_ORDER, panesOf } from "./panes.ts";

function shown(id: string): ShownPanel {
  return { id, panel: { shown: () => true, component: () => null } };
}

const GRILL = shown("grill");

const NOTES = shown("notes");

/** The panes left to right, each by its id. */
function ids(panes: readonly Pane[]): readonly string[] {
  return panes.map((pane) => (pane.kind === "docs" ? DOCS_PANE : pane.id));
}

describe("panesOf", () => {
  test("with no panel shown, the document pane alone", () => {
    expect(panesOf(PANE_ORDER, [])).toEqual([{ kind: "docs" }]);
  });

  test("by default the documents come first, a shown panel after them", () => {
    expect(panesOf(PANE_ORDER, [GRILL])).toEqual([
      { kind: "docs" },
      { kind: "panel", id: "grill", panel: GRILL.panel },
    ]);
  });

  test("the order can put a panel before the documents", () => {
    expect(ids(panesOf(["grill", DOCS_PANE], [GRILL]))).toEqual(["grill", DOCS_PANE]);
  });

  test("panels the order omits follow it, in registry order", () => {
    expect(ids(panesOf(["grill", DOCS_PANE], [NOTES, GRILL]))).toEqual([
      "grill",
      DOCS_PANE,
      "notes",
    ]);
    expect(ids(panesOf([DOCS_PANE], [NOTES, GRILL]))).toEqual([DOCS_PANE, "notes", "grill"]);
  });

  test("a duplicate, an unknown id and a panel not shown are dropped", () => {
    const order = [DOCS_PANE, "grill", DOCS_PANE, "grill", "tabs", "notes"];

    expect(ids(panesOf(order, [GRILL]))).toEqual([DOCS_PANE, "grill"]);
  });

  test("an order that omits the documents still draws them once, first", () => {
    expect(ids(panesOf(["grill"], [GRILL]))).toEqual([DOCS_PANE, "grill"]);
  });
});

describe("guttersOf", () => {
  test("a lone pane keeps a gutter on both sides, for both handles", () => {
    expect(guttersOf(0, 1)).toEqual({ start: true, end: true });
  });

  test("of two, the first keeps the rail's side and the last the comments', whatever they hold", () => {
    expect([guttersOf(0, 2), guttersOf(1, 2)]).toEqual([
      { start: true, end: false },
      { start: false, end: true },
    ]);
  });

  test("a pane between two others keeps none", () => {
    expect(guttersOf(1, 3)).toEqual({ start: false, end: false });
  });
});
