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

  test("a journey's traced steps have their lines right after the plain flow's, forward, back, then under a condition, when the page says the view traces such a step", () => {
    const { legend } = viewOf(deep, "B");

    expect(legendKeys({ ...legend, forward: true, back: true, when: true })).toEqual([
      "flow",
      "forward",
      "back",
      "when",
      "dash",
      "deny",
      "coupled",
      "open",
    ]);
    expect(legendKeys({ ...legend, back: true })).toEqual([
      "flow",
      "back",
      "dash",
      "deny",
      "coupled",
      "open",
    ]);
    expect(legendKeys({ ...legend, forward: false, back: false, when: false })).toEqual(
      legendKeys(legend),
    );
  });

  test("a view using nothing the legend explains has no line", () => {
    expect(
      legendKeys({
        flow: false,
        forward: false,
        back: false,
        when: false,
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

const line = (dash: string): string =>
  `<span><svg viewBox="0 0 26 8" aria-hidden="true"><line x1="0" y1="4" x2="26" y2="4" stroke="var(--accent)" stroke-width="2"${dash}/></svg>`;

describe("legendHtml", () => {
  test("one line per key, its glyph then its label, escaped", () => {
    expect(legendHtml(["deny", "open"], { ...WORDS.en.legend, deny: "<refused>" })).toBe(
      [
        '<span><svg viewBox="0 0 26 8" aria-hidden="true"><line x1="0" y1="4" x2="26" y2="4" stroke="var(--deny)" stroke-width="2"/></svg>&lt;refused&gt;</span>',
        '<span><svg viewBox="0 0 26 12" aria-hidden="true" style="height:12px"><circle cx="13" cy="6" r="4.5" fill="var(--open)"/></svg>open point</span>',
      ].join(""),
    );
  });

  test("the line of a step back, in the colour of a return, in both languages", () => {
    const glyph =
      '<span><svg viewBox="0 0 26 8" aria-hidden="true"><line x1="0" y1="4" x2="26" y2="4" stroke="var(--back)" stroke-width="2"/></svg>';

    expect(legendHtml(["back"], WORDS.fr.legend)).toBe(
      `${glyph}retour : la donnée revient le long du lien</span>`,
    );
    expect(legendHtml(["back"], WORDS.en.legend)).toBe(
      `${glyph}return: the data comes back along the link</span>`,
    );
  });

  test("the lines of a step forward, in the accent, and under a condition, dashed, in both languages", () => {
    expect(legendHtml(["forward", "when"], WORDS.fr.legend)).toBe(
      `${line("")}aller : la donnée suit le lien</span>${line(' stroke-dasharray="5 4"')}sous condition</span>`,
    );
    expect(legendHtml(["forward", "when"], WORDS.en.legend)).toBe(
      `${line("")}forward: the data follows the link</span>${line(' stroke-dasharray="5 4"')}under a condition</span>`,
    );
  });

  test("the line of what comes after the phase picked, in both languages", () => {
    expect(legendHtml(["later"], WORDS.fr.legend)).toEndWith("après la phase choisie</span>");
    expect(legendHtml(["later"], WORDS.en.legend)).toEndWith("after the phase picked</span>");
    expect(legendHtml(["later"], WORDS.en.legend)).toContain('class="later-mark"');
  });
});
