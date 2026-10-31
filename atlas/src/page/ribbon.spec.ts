import { describe, expect, test } from "bun:test";

import MAP from "../../fixtures/journeys/map.ts";
import type { Journey } from "../model/atlas.ts";
import { treeOf } from "../model/tree.ts";
import { ICONS } from "./panel.ts";
import { cellMark, columnsOf, covers, ribbonHtml } from "./ribbon.ts";

const TREE = treeOf(MAP);

const PAY: Journey = MAP.root.journeys[2];

// Two sections, an empty one between them; a form held over three steps, carried again on the
// third, and none before the first carries of each section.
const FORMS: Journey = {
  id: "forms",
  label: "Forms",
  sections: [
    {
      label: "Order",
      steps: [
        { from: "reader", to: "proxy", trigger: "Open the shop", kind: "manual" },
        { from: "proxy", to: "routes", carries: "a request" },
        { from: "routes", to: "cart" },
        { from: "cart", to: "pricing", carries: "a request" },
        { from: "pricing", to: "payment", carries: "a total" },
      ],
    },
    { label: "Nothing", steps: [] },
    {
      label: "Mail",
      steps: [
        { from: "db", to: "outbox", trigger: "Every minute", kind: "auto" },
        { from: "outbox", to: "mailer", carries: "a mail" },
      ],
    },
  ],
};

// The HTML of each column, in order.
const columnsHtml = (journey: Journey): string[] =>
  ribbonHtml(TREE, journey)
    .split('<div class="ribbon-section"')
    .slice(1)
    .map((column) => `<div class="ribbon-section"${column}`);

// The steps a column's cells play, in order.
const stepsIn = (column: string | undefined): number[] =>
  [...(column ?? "").matchAll(/data-step="(\d+)"/gu)].map(([, n]) => Number(n));

describe("the ribbon's columns", () => {
  test("a column per section, its steps numbered across the journey, as wide as their count", () => {
    const columns = columnsOf(PAY);

    expect(columns.map(({ label, first, last }) => ({ label, first, last }))).toEqual([
      { label: "Pay", first: 1, last: 5 },
      { label: "Confirm", first: 6, last: 7 },
    ]);
    expect(columns.map((column) => column.steps.map(({ n }) => n))).toEqual([
      [1, 2, 3, 4, 5],
      [6, 7],
    ]);

    const [pay, confirm] = columnsHtml(PAY);

    expect(pay).toStartWith(
      '<div class="ribbon-section" data-first="1" data-last="5" style="--n: 5"><p class="ribbon-label" title="Pay">Pay</p><div class="ribbon-cells">',
    );
    expect(confirm).toStartWith(
      '<div class="ribbon-section" data-first="6" data-last="7" style="--n: 2"><p class="ribbon-label" title="Confirm">Confirm</p>',
    );
  });

  test("a section without a step has no column, and numbers nothing", () => {
    expect(columnsOf(FORMS).map(({ label, first, last }) => [label, first, last])).toEqual([
      ["Order", 1, 5],
      ["Mail", 6, 7],
    ]);
    expect(columnsHtml(FORMS)).toHaveLength(2);
    expect(ribbonHtml(TREE, FORMS)).not.toContain("Nothing");
  });
});

describe("the ribbon's cells", () => {
  test("each cell carries its number, an entry's icon above it, its step over its ends' labels as its tooltip", () => {
    const html = ribbonHtml(TREE, PAY);

    expect(html).toContain(
      `<button type="button" class="ribbon-cell" data-step="1" title="1. Cart → Pricing"><span class="ribbon-icon">${ICONS.manual}</span><span>1</span></button>`,
    );
    expect(html).toContain(
      '<button type="button" class="ribbon-cell" data-step="2" title="2. Pricing → Payment"><span class="ribbon-icon"></span><span>2</span></button>',
    );
    expect(html).toContain(
      `<button type="button" class="ribbon-cell" data-step="6" title="6. Database → Outbox"><span class="ribbon-icon">${ICONS.auto}</span><span>6</span></button>`,
    );
  });

  test("a step back is marked back, a step under a condition when", () => {
    const html = ribbonHtml(TREE, PAY);

    expect(html).toContain(
      '<button type="button" class="ribbon-cell back" data-step="4" title="4. Card network → Payment">',
    );
    expect(html).toContain(
      '<button type="button" class="ribbon-cell when" data-step="5" title="5. Payment → Database">',
    );
    expect(html.match(/class="ribbon-cell( [^"]*)?"/gu)).toEqual([
      'class="ribbon-cell"',
      'class="ribbon-cell"',
      'class="ribbon-cell"',
      'class="ribbon-cell back"',
      'class="ribbon-cell when"',
      'class="ribbon-cell"',
      'class="ribbon-cell"',
    ]);
  });

  test("each cell sits in its section's column, in order", () => {
    const [pay, confirm] = columnsHtml(PAY);

    expect(stepsIn(pay)).toEqual([1, 2, 3, 4, 5]);
    expect(stepsIn(confirm)).toEqual([6, 7]);
  });

  test("against the step shown, a cell is past, current or next, across the sections", () => {
    expect([1, 4, 5, 6, 7].map((n) => cellMark(n, 5))).toEqual([
      "past",
      "past",
      "current",
      "next",
      "next",
    ]);
    expect(cellMark(1, 1)).toBe("current");
  });

  test("the column holding the step shown is current", () => {
    const [pay, confirm] = columnsOf(PAY);

    expect(pay !== undefined && covers(pay, 5)).toBe(true);
    expect(confirm !== undefined && covers(confirm, 5)).toBe(false);
    expect(confirm !== undefined && covers(confirm, 6)).toBe(true);
  });
});

describe("the ribbon's data row", () => {
  test("each form covers the steps it holds, one after another; a step without a form has none", () => {
    expect(columnsOf(FORMS).map((column) => column.runs)).toEqual([
      [
        { form: "a request", first: 2, last: 4 },
        { form: "a total", first: 5, last: 5 },
      ],
      [{ form: "a mail", first: 7, last: 7 }],
    ]);
    expect(columnsOf(PAY).flatMap((column) => column.runs.map(({ form }) => form))).toEqual([
      "the cart",
      "the total, taxes included",
      "a charge",
      "an authorisation",
      "the order",
      "orders placed",
      "a confirmation",
    ]);
  });

  test("a form lies over the cells of its steps, its whole text as its tooltip", () => {
    const [order, mail] = columnsHtml(FORMS);

    expect(order).toEndWith(
      '<div class="ribbon-forms">' +
        '<span class="ribbon-form" data-first="2" data-last="4" style="grid-column: 2 / span 3" title="a request">a request</span>' +
        '<span class="ribbon-form" data-first="5" data-last="5" style="grid-column: 5 / span 1" title="a total">a total</span>' +
        "</div></div>",
    );
    expect(mail).toEndWith(
      '<div class="ribbon-forms"><span class="ribbon-form" data-first="7" data-last="7" style="grid-column: 2 / span 1" title="a mail">a mail</span></div></div>',
    );
  });

  test("the form the step shown holds is lit, none while the data has no form", () => {
    const [order] = columnsOf(FORMS);
    const runs = order?.runs ?? [];

    expect([1, 2, 3, 4, 5].map((step) => runs.findIndex((r) => covers(r, step)))).toEqual([
      -1, 0, 0, 0, 1,
    ]);
  });
});

describe("the ribbon's texts", () => {
  test("plain text, shown as written, in the labels, the tooltips and the data row", async () => {
    const hostile = '<img src=x onerror="alert(1)">';

    const journey: Journey = {
      id: "hostile",
      label: hostile,
      sections: [
        {
          label: hostile,
          steps: [
            { from: "reader", to: "proxy", trigger: hostile, kind: "manual", carries: hostile },
          ],
        },
      ],
    };

    const html = ribbonHtml(TREE, journey);
    let images = 0;

    await new HTMLRewriter()
      .on("img", {
        element() {
          images += 1;
        },
      })
      .transform(new Response(html))
      .text();

    expect(images).toBe(0);
    expect(html.split("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;")).toHaveLength(5);
  });
});
