import { describe, expect, test } from "bun:test";

import { parseWipDir } from "./paths.ts";
import type { PlugsOf } from "./plugs.ts";
import { core, defineSlice, heard } from "./plugs.ts";
import type { SlicePart } from "./rows.ts";
import { allOf, anyOf, naming, rows, tablePart } from "./rows.ts";
import type { Workflow } from "./workflow.ts";
import { tableOf, unchanged } from "./workflow.ts";

const DIR = parseWipDir("plans/2026-09-28/wip-5e1ce000/");

if (!DIR.ok) throw new Error(DIR.error);

const W: Workflow = {
  workspace: { kind: "drafting", dir: DIR.value, batches: 0 },
  planText: "absent",
  regions: [],
};

/** A slice's events, another slice's `pick` as its contract types it, and the core's `approve`. */
const SLICE = defineSlice({
  id: "slice",
  events: {
    ask: { by: ["claude"], carries: ["id", "text"] },
    drop: { by: ["engine", "reviewer"], carries: ["id"] },
  },
  hears: {
    pick: heard<{ readonly carries: readonly ["id", "move"] }>(),
    approve: core,
  },
});

type Plugs = PlugsOf<typeof SLICE>;

const { refuse, whileHeld } = rows(SLICE);

const always = (): boolean => true;

const fails = (): boolean => false;

const { missing } = naming({ missing: (): boolean => true });

type Part = SlicePart<Plugs["events"], Plugs["hears"]>;

function partOf(rules: Part["rules"], reactions: Part["reactions"] = {}): Part {
  return {
    events: SLICE.events,
    rules,
    samples: { ask: [{ id: "a1", text: "Why?" }], drop: [{ id: "a1" }] },
    transitions: { ask: unchanged, drop: unchanged },
    reactions,
  };
}

describe("a slice's rows", () => {
  test("each row carries the status its routes answer and the names of the guards it is built from", () => {
    const part = tablePart(
      "slice",
      partOf([
        whileHeld("ask", 409, (hold) => hold),
        refuse("ask", "gone", anyOf(allOf(always, fails), always), 404, "gone"),
      ]),
    );

    const held = part.events.find(({ id }) => id === "ask")?.whileHeld;

    expect(part.rules.map(({ id, status, condition }) => [id, status, condition])).toEqual([
      ["gone", 404, "(always and fails) or always"],
    ]);
    expect(held?.effect === "refuse" ? held.status : null).toBe(409);
  });

  test("a row above the event's hold row is judged before the hold, one below it after", () => {
    const part = tablePart(
      "slice",
      partOf([
        refuse("ask", "first", always, 409, "first"),
        whileHeld("ask", 409, (hold) => `${hold}: wait`),
        refuse("ask", "then", missing, 404, "then"),
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
      partOf([
        refuse("drop", "one", always, 409, "one"),
        refuse("drop", "two", always, 409, "two"),
      ]),
    );

    expect(part.events.find(({ id }) => id === "drop")?.whileHeld).toEqual({ effect: "allow" });
    expect(part.rules.map(({ order }) => order)).toEqual([1, 2]);
  });

  test("the hold's row words the refusal with the hold", () => {
    const part = tablePart("slice", partOf([whileHeld("ask", 409, (hold) => `${hold}: wait`)]));
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
          409,
          "seen",
        ),
      ]),
    );

    part.rules[0]?.when(W, { id: "a1", other: "dropped" });

    expect(seen).toEqual([{ id: "a1", text: "", at: "", seq: "" }]);
  });

  test("a row refuses the input when one of its guards names what is not there, the state otherwise", () => {
    const part = tablePart(
      "slice",
      partOf([
        refuse("ask", "named", allOf(always, missing), 404, "named"),
        refuse("ask", "either", anyOf(fails, missing), 404, "either"),
        refuse("ask", "state", allOf(always, fails), 409, "state"),
      ]),
    );

    expect(part.rules.map(({ id, refuses, condition }) => [id, refuses, condition])).toEqual([
      ["named", "input", "always and missing"],
      ["either", "input", "fails or missing"],
      ["state", "state", "always and fails"],
    ]);
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
      ["drop", "slice", ["engine", "reviewer"], [{ id: "a1" }]],
    ]);
  });

  test("a row on an event another part owns is judged after every row of that part, and reads its input as it comes", () => {
    const seen: unknown[] = [];

    const noted = (_w: Workflow, input: { readonly move: string | undefined }): boolean => {
      seen.push(input);

      return false;
    };

    const part = tablePart(
      "slice",
      partOf([refuse("pick", "first", noted, 409, "a"), refuse("pick", "then", always, 409, "b")]),
    );

    part.rules[0]?.when(W, { id: "p1", move: "grill" });

    expect(part.rules.map(({ event, id, order }) => [event, id, order])).toEqual([
      ["pick", "first", 100],
      ["pick", "then", 101],
    ]);
    expect(seen).toEqual([{ id: "p1", move: "grill" }]);
  });

  test("a reaction answers the events it hears, and leaves the others as they are", () => {
    const answered: string[] = [];

    const part = tablePart(
      "slice",
      partOf([], {
        pick: (w, input) => {
          answered.push(input.move ?? "");

          return unchanged(w);
        },
      }),
    );

    part.reaction?.(W, "pick", { move: "grill" });
    part.reaction?.(W, "approve", { at: "t" });
    part.reaction?.(W, "ask", { id: "a1" });

    expect(answered).toEqual(["grill"]);
  });

  test("two hold rows on one event are refused as the table is built", () => {
    const twice = partOf([
      whileHeld("ask", 409, (hold) => hold),
      whileHeld("ask", 409, (hold) => hold),
    ]);

    expect(() => tablePart("slice", twice)).toThrow("ask has 2 hold rows: one at most");
  });
});

describe("the table", () => {
  test("an event two parts declare is refused as the table is built, naming both", () => {
    const one = tablePart("one", partOf([]));
    const other = tablePart("other", partOf([]));

    expect(() => tableOf([one, other])).toThrow("ask is declared by both one and other");
  });

  test("an event of the core's declared again by a part is refused too", () => {
    const part = tablePart("slice", partOf([]));
    const clash = { ...part, events: part.events.map((event) => ({ ...event, id: "record" })) };

    expect(() => tableOf([clash])).toThrow("record is declared by both core and slice");
  });
});
