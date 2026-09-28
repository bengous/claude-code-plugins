import { describe, expect, test } from "bun:test";

import { parseWipDir } from "./paths.ts";
import type { SlicePart } from "./rows.ts";
import { allOf, anyOf, events, rows, tablePart } from "./rows.ts";
import type { Workflow } from "./workflow.ts";
import { unchanged } from "./workflow.ts";

const DIR = parseWipDir("plans/2026-09-28/wip-5e1ce000/");

if (!DIR.ok) throw new Error(DIR.error);

const W: Workflow = {
  workspace: { kind: "drafting", dir: DIR.value, batches: 0 },
  planText: "absent",
  regions: [],
};

const EVENTS = events({
  ask: { by: "claude", carries: ["id", "text"] },
  drop: { by: "engine", carries: ["id"] },
});

const { refuse, refuseInput, whileHeld } = rows(EVENTS);

const always = (): boolean => true;

const fails = (): boolean => false;

function partOf(rules: SlicePart<typeof EVENTS>["rules"]): SlicePart<typeof EVENTS> {
  return {
    events: EVENTS,
    rules,
    samples: { ask: [{ id: "a1", text: "Why?" }], drop: [{ id: "a1" }] },
    transitions: { ask: unchanged, drop: unchanged },
  };
}

describe("a slice's rows", () => {
  test("a row above the event's hold row is judged before the hold, one below it after", () => {
    const part = tablePart(
      "slice",
      partOf([
        refuse("ask", "first", always, "first"),
        whileHeld("ask", (hold) => `${hold}: wait`),
        refuseInput("ask", "then", always, "then"),
      ]),
    );

    expect(part.rules.map(({ id, order, refuses }) => [id, order, refuses])).toEqual([
      ["first", -1, "state"],
      ["then", 1, "input"],
    ]);
  });

  test("an event with no hold row passes a hold, its rows after where the hold stands", () => {
    const part = tablePart(
      "slice",
      partOf([refuse("drop", "one", always, "one"), refuse("drop", "two", always, "two")]),
    );

    expect(part.events.find(({ id }) => id === "drop")?.whileHeld).toEqual({ effect: "allow" });
    expect(part.rules.map(({ order }) => order)).toEqual([1, 2]);
  });

  test("the hold's row words the refusal with the hold", () => {
    const part = tablePart("slice", partOf([whileHeld("ask", (hold) => `${hold}: wait`)]));
    const held = part.events.find(({ id }) => id === "ask")?.whileHeld;

    expect(held?.effect === "refuse" ? held.reason("grill 1 is open") : null).toBe(
      "grill 1 is open: wait",
    );
  });

  test("a guard reads what its event carries and the stamps, an empty text for any the input lacks", () => {
    const seen: unknown[] = [];

    const part = tablePart(
      "slice",
      partOf([
        refuse(
          "ask",
          "seen",
          (_w, input) => {
            seen.push(input);

            return false;
          },
          "seen",
        ),
      ]),
    );

    part.rules[0]?.when(W, { id: "a1", other: "dropped" });

    expect(seen).toEqual([{ id: "a1", text: "", at: "", seq: "" }]);
  });

  test("allOf holds when every guard does, anyOf when one does", () => {
    const input = { id: "", text: "", at: "", seq: "" };

    expect([allOf(always, fails)(W, input), anyOf(always, fails)(W, input)]).toEqual([false, true]);
  });

  test("a transition reads what its event carries and the stamps", () => {
    const seen: unknown[] = [];

    const part = tablePart("slice", {
      ...partOf([]),
      transitions: {
        ask: (w, input) => {
          seen.push(input);

          return unchanged(w);
        },
        drop: unchanged,
      },
    });

    part.transitions.ask?.(W, "ask", { id: "a1", text: "Why?", at: "t", seq: "3" });

    expect(seen).toEqual([{ id: "a1", text: "Why?", at: "t", seq: "3" }]);
  });

  test("each event keeps its sender and its samples, under its slice", () => {
    const part = tablePart("slice", partOf([]));

    expect(
      part.events.map(({ id, owner, actors, samples }) => [id, owner, actors, samples]),
    ).toEqual([
      ["ask", "slice", ["claude"], [{ id: "a1", text: "Why?" }]],
      ["drop", "slice", ["engine"], [{ id: "a1" }]],
    ]);
  });

  test("two hold rows on one event are refused as the table is built", () => {
    const twice = partOf([whileHeld("ask", (hold) => hold), whileHeld("ask", (hold) => hold)]);

    expect(() => tablePart("slice", twice)).toThrow("ask has 2 hold rows: one at most");
  });
});
