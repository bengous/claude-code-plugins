import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Chip } from "./rounds.ts";
import { roundNow, roundsOf } from "./rounds.ts";
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

describe("the round's part of a Send", () => {
  test("closes the open questions, in order: the ones the chips and the band read", () => {
    expect(roundsOf(ASKING, { Q7: "As recommended." }, null).open).toEqual(["Q7", "Q8"]);
    expect(roundsOf(SENT, NOTHING_TYPED, null).open).toEqual([]);
  });

  test("counts as waiting the open questions the draft leaves untouched, as the chips", () => {
    expect(roundsOf(ASKING, NOTHING_TYPED, null).waiting).toBe(2);
    expect(roundsOf(ASKING, { Q7: "As recommended.", Q8: " " }, null).waiting).toBe(1);
    expect(roundsOf(SENT, NOTHING_TYPED, null).waiting).toBe(0);
  });
});

describe("the round the grill stands in", () => {
  test("is the last one asked, 0 before the first", () => {
    expect(roundNow(SENT)).toBe(3);
    expect(roundNow(ASKING)).toBe(3);
    expect(roundNow(SENT.filter((block) => block.kind !== "question"))).toBe(0);
  });
});
