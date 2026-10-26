import { describe, expect, test } from "bun:test";

import SAMPLE from "../../fixtures/sample/map.ts";
import { DEEP } from "../../fixtures/trees.ts";
import { treeOf } from "../model/tree.ts";
import { viewOf } from "../model/view.ts";
import { WORDS } from "../model/words.ts";
import { legendHtml, legendKeys } from "./legend.ts";

const sample = treeOf(SAMPLE);

const deep = treeOf(DEEP);

describe("legendKeys", () => {
  test("a view's legend has a line for each kind it uses, in legend order", () => {
    expect(legendKeys(viewOf(sample, null).legend)).toEqual(["flow", "coupled", "outside", "open"]);
    expect(legendKeys(viewOf(sample, "data").legend)).toEqual(["flow", "dash", "coupled", "open"]);
    expect(legendKeys(viewOf(deep, "B").legend)).toEqual([
      "flow",
      "dash",
      "deny",
      "coupled",
      "open",
    ]);
  });

  test("a view using nothing the legend explains has no line", () => {
    expect(
      legendKeys({
        flow: false,
        dash: false,
        deny: false,
        coupled: false,
        outside: false,
        open: false,
        later: false,
      }),
    ).toEqual([]);
  });

  test("what comes after the phase picked has the last line, when the page says the view draws some", () => {
    const { legend } = viewOf(sample, null);

    expect(legendKeys({ ...legend, later: true })).toEqual([
      "flow",
      "coupled",
      "outside",
      "open",
      "later",
    ]);
    expect(legendKeys({ ...legend, later: false })).toEqual(["flow", "coupled", "outside", "open"]);
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

  test("the line of what comes after the phase picked, in both languages", () => {
    expect(legendHtml(["later"], WORDS.fr.legend)).toEndWith("après la phase choisie</span>");
    expect(legendHtml(["later"], WORDS.en.legend)).toEndWith("after the phase picked</span>");
    expect(legendHtml(["later"], WORDS.en.legend)).toContain('class="later-mark"');
  });
});
