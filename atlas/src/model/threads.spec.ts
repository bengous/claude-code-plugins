import { describe, expect, test } from "bun:test";

import SAMPLE from "../../fixtures/sample/map.ts";
import { DEEP } from "../../fixtures/trees.ts";
import { appendEntry, firstLine, openItems, readThreads, waitsFor } from "./threads.ts";
import { treeOf } from "./tree.ts";

const sample = treeOf(SAMPLE);

describe("open points", () => {
  test("every open point has a unique id and a text", () => {
    const items = openItems(sample);
    expect(items.length).toBeGreaterThan(0);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);

    for (const item of items) {
      expect(firstLine(item.text)).not.toBe("");
    }
  });

  test("each point names its owner, a container or a leaf, in tree order", () => {
    expect(openItems(treeOf(DEEP))).toEqual([
      {
        id: "a11-open",
        text: "a11-open is unsettled",
        owner: "A11",
        ownerLabel: "A11",
        kind: "container",
      },
      { id: "a1-open", text: "a1-open is unsettled", owner: "a1", ownerLabel: "a1", kind: "leaf" },
      {
        id: "b1-first",
        text: "b1-first is unsettled",
        owner: "b1",
        ownerLabel: "b1",
        kind: "leaf",
      },
      {
        id: "b1-second",
        text: "b1-second is unsettled",
        owner: "b1",
        ownerLabel: "b1",
        kind: "leaf",
      },
    ]);
  });

  test("the first line drops tags and decodes entities", () => {
    expect(firstLine("Le mode <code>block</code> &lt;ci&gt;\nsuite")).toBe("Le mode block <ci>");
  });
});

describe("waitsFor", () => {
  test("a point without a thread waits for nobody", () => {
    expect(waitsFor([])).toBeNull();
  });

  test("a point waits for the party that did not write last", () => {
    expect(waitsFor([{ who: "human", text: "a" }])).toBe("agent");
    expect(
      waitsFor([
        { who: "human", text: "a" },
        { who: "agent", text: "b" },
      ]),
    ).toBe("human");
  });
});

describe("readThreads", () => {
  test("an entry without text is reported and dropped", () => {
    const read = readThreads({
      x: [
        { who: "agent", text: " " },
        { who: "human", text: "ok" },
      ],
    });

    expect(read.errors).toEqual(["threads.json x[0]: text must be a non-empty string"]);
    expect(read.threads).toEqual({ x: [{ who: "human", text: "ok" }] });
  });

  test("a top level that is not an object is reported", () => {
    expect(readThreads([]).errors).toHaveLength(1);
  });

  test("appendEntry adds to the end of the thread and keeps the others", () => {
    const next = appendEntry({ a: [{ who: "agent", text: "1" }], b: [] }, "a", {
      who: "human",
      text: "2",
    });

    expect(next).toEqual({
      a: [
        { who: "agent", text: "1" },
        { who: "human", text: "2" },
      ],
      b: [],
    });
  });
});
