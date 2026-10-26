import { describe, expect, test } from "bun:test";

import type { AtlasMap } from "./atlas.ts";
import { citationOf, citedLines, mapCitations, withCitations } from "./citations.ts";

describe("citationOf", () => {
  test.each([
    ["src/serve.ts:380", "src/serve.ts", [{ first: 380, last: 380 }]],
    ["src/serve.ts:452-453", "src/serve.ts", [{ first: 452, last: 453 }]],
    ["a.ts:7-7", "a.ts", [{ first: 7, last: 7 }]],
  ])("reads a line or a range: %s", (text, path, lines) => {
    expect(citationOf(text)).toEqual({ path, lines });
  });

  test("reads a comma list of lines and ranges, in its order", () => {
    expect(citationOf("orders/orders.go:30,44-46,12")).toEqual({
      path: "orders/orders.go",
      lines: [
        { first: 30, last: 30 },
        { first: 44, last: 46 },
        { first: 12, last: 12 },
      ],
    });
  });

  test.each([
    "atlas/src/model/folder.ts:12",
    ".github/workflows/ci.yml:5",
    "../shared/a.b.config.ts:1",
    "app/(shop)/[id]/page.tsx:3",
    "deploy/Caddyfile:9",
    "@scope/pkg-name_2/index.d.ts:40-41",
  ])("reads a path with dots, slashes and the marks a repository's names carry: %s", (text) => {
    expect(citationOf(text)?.path).toBe(text.slice(0, text.lastIndexOf(":")));
  });

  test.each([
    ["no lines", "src/serve.ts"],
    ["an empty line list", "src/serve.ts:"],
    ["no path", ":12"],
    ["a word for lines", "src/serve.ts:twelve"],
    ["a range with no end", "a.ts:12-"],
    ["a range with no start", "a.ts:-3"],
    ["line 0", "a.ts:0"],
    ["a range that runs backwards", "a.ts:9-3"],
    ["a list that ends on a comma", "a.ts:1,"],
    ["a space before the lines", "a.ts: 12"],
    ["a space after a comma", "a.ts:1, 3"],
    ["a space in the path", "my file.ts:1"],
    ["text after the lines", "a.ts:1 and below"],
    ["an address", "https://example.com:443/x"],
    ["a quote in the path", 'a"b.ts:1'],
    ["an entity in the path", "a&amp;b.ts:1"],
    ["a title", "the shop's notes"],
    ["nothing", ""],
  ])("is not a citation: %s", (_, text) => {
    expect(citationOf(text)).toBeNull();
  });
});

test("citedLines writes the lines alone, as a marker shows them", () => {
  const cited = citationOf("a.ts:30,044-46");

  expect(cited === null ? null : citedLines(cited)).toBe("30,44-46");
});

const marked = (html: string): string => withCitations(html, (c) => `[${c.path} ${citedLines(c)}]`);

describe("withCitations", () => {
  test("replaces each <cite> that holds a citation, and leaves every other one", () => {
    expect(
      marked("Writes <cite>a.ts:3</cite>, as <cite>the docs</cite> say <cite>b/c.go:1-2</cite>."),
    ).toBe("Writes [a.ts 3], as <cite>the docs</cite> say [b/c.go 1-2].");
  });

  test("leaves a <cite> that holds markup", () => {
    expect(marked("<cite><code>a.ts</code>:3</cite>")).toBe("<cite><code>a.ts</code>:3</cite>");
  });
});

test("mapCitations finds every citation of the map's HTML fields, by node and field", () => {
  const map: AtlasMap = {
    root: {
      title: "T",
      lead: "One <cite>a.ts:1</cite>, two <CITE>b.ts:2-3</CITE>.",
      kicker: "<cite>k.ts:1</cite>",
      src: "a.ts",
      children: [
        {
          id: "n",
          label: "N",
          sub: "<cite>sub.ts:1</cite>",
          color: "c",
          io: [["<cite>key.ts:1</cite>", "<cite>c.ts:4</cite>"]],
          alt: "<cite>the docs</cite>",
          open: [{ id: "o", text: "<cite>d.ts:5,9</cite>" }],
        },
      ],
    },
    links: [],
  };

  expect(
    mapCitations(map).map(({ where, field, citation }) => `${where} ${field} ${citation.path}`),
  ).toEqual(["root lead a.ts", "root lead b.ts", "node n io c.ts", "node n open d.ts"]);
});
