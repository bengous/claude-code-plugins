import { describe, expect, test } from "bun:test";

import { BODIES, parseReviewState } from "./parse.ts";

describe("parseReviewState", () => {
  const RUNNING = {
    kind: "running" as const,
    seq: 2,
    version: 3,
    agentId: "a1",
    model: "claude-opus-5-5",
  };

  const QUIET = { stopping: [] };

  test("a run under way and the last failure cross, a failure never launched with no model", () => {
    const failed = { seq: 1, version: 3, model: null, why: "no such agent" };

    expect(parseReviewState({ run: RUNNING, failed, ...QUIET })).toEqual({
      run: RUNNING,
      failed,
      ...QUIET,
    });
    expect(parseReviewState({ run: null, failed: null, ...QUIET })).toEqual({
      run: null,
      failed: null,
      ...QUIET,
    });
  });

  test("the agents to stop cross, and a field an older server wrote is left behind", () => {
    const state = { run: null, failed: null, stopping: [{ seq: 2, agentId: "a1" }] };

    expect(parseReviewState({ ...state, older: true })).toEqual(state);
  });

  test("a run missing a part, or a number that is no count, is no state", () => {
    expect(
      parseReviewState({ run: { ...RUNNING, agentId: "" }, failed: null, ...QUIET }),
    ).toBeNull();
    expect(parseReviewState({ run: { ...RUNNING, seq: 0 }, failed: null, ...QUIET })).toBeNull();
    expect(
      parseReviewState({ run: { ...RUNNING, kind: "done" }, failed: null, ...QUIET }),
    ).toBeNull();
    expect(parseReviewState({ failed: null, ...QUIET })).toBeNull();
  });

  test("a state without its agents to stop, or with one missing its id, is no state", () => {
    expect(parseReviewState({ run: null, failed: null })).toBeNull();
    expect(parseReviewState({ run: null, failed: null, stopping: [{ seq: 1 }] })).toBeNull();
  });
});

describe("BODIES", () => {
  test("an answer is a text with something in it, kept as written", () => {
    const answer = { kind: "answer" as const, text: "  ## Plan review\n" };

    expect(BODIES["POST ended"]({ seq: 1, outcome: answer })).toEqual({ seq: 1, outcome: answer });
    expect(BODIES["POST ended"]({ seq: 1, outcome: { kind: "answer", text: " \n" } })).toBeNull();
  });
});
