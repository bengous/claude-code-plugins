import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Chip } from "./rounds.ts";
import { roundsOf } from "./rounds.ts";
import { blocksOf } from "./server.ts";

/** A real grill, closed: three rounds, Q1 to Q8, answers of every kind. */
const GRILL = readFileSync(
  join(import.meta.dir, "../../../e2e/fixtures/grill-real/grill-1.md"),
  "utf8",
);

const SENT = blocksOf(GRILL);

/** The same grill before its last reply: round 3, Q7 and Q8, still open. */
const ASKING = blocksOf(GRILL.slice(0, GRILL.lastIndexOf("\n### Reviewer")));

const NOTHING_TYPED = {};

describe("the chips", () => {
  test("of a grill sent: answered or taken by default, by round", () => {
    expect(roundsOf(SENT, NOTHING_TYPED, null).rounds).toEqual([
      {
        n: 1,
        chips: [
          { id: "Q1", state: "answered" },
          { id: "Q2", state: "answered" },
          { id: "Q3", state: "answered" },
        ],
      },
      {
        n: 2,
        chips: [
          { id: "Q4", state: "answered" },
          { id: "Q5", state: "default" },
          { id: "Q6", state: "default" },
        ],
      },
      {
        n: 3,
        chips: [
          { id: "Q7", state: "default" },
          { id: "Q8", state: "default" },
        ],
      },
    ]);
  });

  test("of a round open: waiting, until the draft chooses the recommendation or holds a text", () => {
    const chips = (answers: Record<string, string>): readonly Chip[] | undefined =>
      roundsOf(ASKING, answers, null).rounds.at(-1)?.chips;

    expect(chips(NOTHING_TYPED)).toEqual([
      { id: "Q7", state: "waiting" },
      { id: "Q8", state: "waiting" },
    ]);
    expect(chips({ Q7: "As recommended.", Q8: " " })).toEqual([
      { id: "Q7", state: "answered" },
      { id: "Q8", state: "waiting" },
    ]);
  });
});

describe("the question shown", () => {
  test("is the round's first open one, until the reviewer picks another", () => {
    expect(roundsOf(ASKING, NOTHING_TYPED, null).current?.id).toBe("Q7");
    expect(roundsOf(ASKING, NOTHING_TYPED, "Q2").current?.title).toBe(
      "Où vit une dépendance de test",
    );
  });

  test("is none between rounds, until one is picked; an id no question holds picks nothing", () => {
    expect(roundsOf(SENT, NOTHING_TYPED, null).current).toBeNull();
    expect(roundsOf(SENT, NOTHING_TYPED, "Q99").current).toBeNull();
    expect(roundsOf(SENT, NOTHING_TYPED, "Q5").current?.round).toBe(2);
  });

  test("has its neighbours across rounds, and none past either end", () => {
    const at = (picked: string): readonly (string | null)[] => {
      const { previous, next } = roundsOf(SENT, NOTHING_TYPED, picked);

      return [previous, next];
    };

    expect(at("Q4")).toEqual(["Q3", "Q5"]);
    expect(at("Q1")).toEqual([null, "Q2"]);
    expect(at("Q8")).toEqual(["Q7", null]);
  });
});

describe("the send", () => {
  test("says how many open questions it takes as recommended", () => {
    const send = (answers: Record<string, string>): string => roundsOf(ASKING, answers, null).send;

    expect(send(NOTHING_TYPED)).toBe("Send round · 2 taken as recommended");
    expect(send({ Q7: "As recommended." })).toBe("Send round · 1 taken as recommended");
    expect(send({ Q7: "Every push.", Q8: "As recommended." })).toBe("Send round");
  });

  test("with no question open, sends a note", () => {
    expect(roundsOf(SENT, NOTHING_TYPED, null).send).toBe("Send note");
  });
});
