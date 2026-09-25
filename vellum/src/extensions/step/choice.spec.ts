import { describe, expect, test } from "bun:test";

import { answerOf, NO_PICK, oneLine, OWN_GRILL } from "./choice.ts";
import type { Move } from "./protocol.ts";

const GRILL: Move = { kind: "grill", subject: "auth", choices: ["Sessions"] };

const MOVES: readonly Move[] = [GRILL, { kind: "plan" }];

describe("answerOf", () => {
  test("nothing picked sends nothing: no move is taken for the reviewer", () => {
    expect(answerOf(NO_PICK, MOVES)).toBeNull();
  });

  test("a move offered sends it as Claude wrote it", () => {
    expect(answerOf({ kind: "move", index: 0 }, MOVES)).toEqual({ kind: "move", move: GRILL });
    expect(answerOf({ kind: "move", index: 2 }, MOVES)).toBeNull();
  });

  test("a step of the reviewer's own takes its text on one line, and none without one", () => {
    expect(
      answerOf({ kind: "other", other: "grill", text: " Where do\ndrafts live? " }, []),
    ).toEqual({
      kind: "move",
      move: { kind: "grill", subject: "Where do drafts live?", choices: [] },
    });
    expect(answerOf({ kind: "other", other: "mockup", text: "the bar" }, [])).toEqual({
      kind: "move",
      move: { kind: "mockup", screen: "the bar" },
    });
    expect(answerOf({ kind: "other", other: "prototype", text: "drag" }, [])).toEqual({
      kind: "move",
      move: { kind: "prototype", question: "drag" },
    });
    expect(answerOf(OWN_GRILL, [])).toBeNull();
  });

  test("the plan needs no text, and the reviewer's own words keep their lines", () => {
    expect(answerOf({ kind: "other", other: "plan", text: "" }, [])).toEqual({
      kind: "move",
      move: { kind: "plan" },
    });
    expect(
      answerOf({ kind: "other", other: "own", text: "Read the issue.\nThen plan." }, []),
    ).toEqual({
      kind: "own",
      text: "Read the issue.\nThen plan.",
    });
    expect(answerOf({ kind: "other", other: "own", text: " " }, [])).toBeNull();
  });
});

describe("oneLine", () => {
  test("turns every break a line reader cuts at into one space", () => {
    expect(oneLine("a\n b\r\nc d")).toBe("a b c d");
  });
});
