import { describe, expect, test } from "bun:test";

import type { AtlasMap } from "./atlas.ts";
import { keptMarkup, mapMarkupFaults, markupFaults } from "./markup.ts";

describe("keptMarkup", () => {
  test("keeps code, cite, b, i, em, strong and br without attributes", () => {
    expect(keptMarkup("<code>x</code> <cite>a.ts:1</cite> <B>b</B> <br/> <em>e</em>")).toBe(
      "<code>x</code> <cite>a.ts:1</cite> <b>b</b> <br> <em>e</em>",
    );
  });

  test("shows any other tag, a kept one with attributes, and a comment as text", () => {
    expect(keptMarkup('<img src=x onerror="alert(1)">')).toBe('&lt;img src=x onerror="alert(1)">');
    expect(keptMarkup('<code onclick="x">y</code>')).toBe('&lt;code onclick="x">y</code>');
    expect(keptMarkup("<!-- c --><script>1</script>")).toBe(
      "&lt;!-- c -->&lt;script>1&lt;/script>",
    );
  });

  test("leaves text and entities as they are", () => {
    expect(keptMarkup("a &lt; b & c > d")).toBe("a &lt; b & c > d");
  });
});

describe("markupFaults", () => {
  test("names each tag a panel would not keep, and no bare <", () => {
    expect(markupFaults("a < b <code>c</code>")).toEqual([]);
    expect(markupFaults('<img src=x onerror="a"> and <b class="x">')).toEqual([
      '<img src=x onerror="a">',
      '<b class="x">',
    ]);
  });
});

describe("mapMarkupFaults", () => {
  test("names the node and the field of every fault, an open point's text included", () => {
    const map: AtlasMap = {
      root: {
        title: "T",
        lead: "<script>x</script>",
        children: [
          {
            id: "a",
            label: "A",
            sub: "",
            color: "c",
            io: [["Receives", "<code>ok</code>"]],
            pitfalls: ['<a href="javascript:x">y</a>'],
            open: [{ id: "o", text: "<img src=x>" }],
          },
        ],
      },
      links: [],
    };

    expect(mapMarkupFaults(map).map((fault) => fault.split(" is ")[0])).toEqual([
      "root: lead: <script>",
      "root: lead: </script>",
      'node a: pitfalls: <a href="javascript:x">',
      "node a: pitfalls: </a>",
      "node a: open: <img src=x>",
    ]);
  });
});
