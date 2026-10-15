import { beforeEach, describe, expect, test } from "bun:test";

import type { Verdict } from "./hook.ts";
import { clearFailures, diagnosticKey, failureKey, guard, resetTurn } from "./loop-guard.ts";
import type { SessionState } from "./state.ts";
import { freshState } from "./state.ts";
import { scrubGitEnv } from "./test-support.ts";

type PromptPayload = { readonly promptId?: string };

const CAP = 3;

let state: SessionState;

beforeEach(() => {
  scrubGitEnv();
  state = freshState("s", "/r");
});

function noteText(verdict: Verdict): string {
  if (verdict.kind !== "note") {
    throw new Error(`expected a note, got ${verdict.kind}`);
  }

  return verdict.text;
}

describe("guard", () => {
  const failing = { lint: ["a.ts"] };
  const diagnostics = { [diagnosticKey("lint", "a.ts")]: 4 };

  test("the first failure blocks and saves the failing set", () => {
    expect(guard(state, failing, diagnostics, CAP, "fix lint")).toEqual({
      kind: "block",
      reason: "fix lint",
    });
    expect(state.blocksInTurn).toBe(1);
    expect(state.lastFailing).toEqual(failing);
    expect(state.lastDiagnostics).toEqual(diagnostics);
  });

  test("the same set with the same counts lets the turn end with a note", () => {
    guard(state, failing, diagnostics, CAP, "fix lint");
    const text = noteText(guard(state, { lint: ["a.ts"] }, { ...diagnostics }, CAP, "fix lint"));

    expect(text).toStartWith("agent-hooks: same failures as the previous Stop");
    expect(text).toEndWith("\nfix lint");
    expect(state.blocksInTurn).toBe(1);
  });

  test("the same set with more diagnostics lets the turn end with a note", () => {
    guard(state, failing, diagnostics, CAP, "r");

    expect(guard(state, failing, { [diagnosticKey("lint", "a.ts")]: 9 }, CAP, "r").kind).toBe(
      "note",
    );
  });

  test("the same set with fewer diagnostics blocks again", () => {
    guard(state, failing, diagnostics, CAP, "r");

    expect(guard(state, failing, { [diagnosticKey("lint", "a.ts")]: 2 }, CAP, "r")).toEqual({
      kind: "block",
      reason: "r",
    });
    expect(state.blocksInTurn).toBe(2);
  });

  test("a different set blocks again", () => {
    guard(state, failing, diagnostics, CAP, "r");

    expect(guard(state, { lint: ["b.ts"] }, diagnostics, CAP, "r").kind).toBe("block");
    expect(state.lastFailing).toEqual({ lint: ["b.ts"] });
  });

  test("after cap blocks in a row with progress each time, a note", () => {
    for (let round = 1; round <= CAP; round += 1) {
      expect(guard(state, { lint: [`f${round}.ts`] }, {}, CAP, "r").kind).toBe("block");
    }

    expect(state.blocksInTurn).toBe(CAP);
    expect(noteText(guard(state, { lint: ["next.ts"] }, {}, CAP, "r"))).toStartWith(
      "agent-hooks: 3 blocks in a row",
    );
  });
});

describe("resetTurn", () => {
  test("a new prompt id resets the block counter", () => {
    state.blocksInTurn = 2;
    state.promptId = "p1";
    resetTurn(state, "p2");

    expect(state.blocksInTurn).toBe(0);
    expect(state.promptId).toBe("p2");
  });

  test("the same prompt id or undefined leaves the counter", () => {
    state.blocksInTurn = 2;
    state.promptId = "p1";
    resetTurn(state, "p1");

    expect(state.blocksInTurn).toBe(2);

    const payloadWithoutPromptId: PromptPayload = {};
    resetTurn(state, payloadWithoutPromptId.promptId);

    expect(state.blocksInTurn).toBe(2);
    expect(state.promptId).toBe("p1");
  });

  test("the first prompt id of a fresh state is a new turn", () => {
    state.blocksInTurn = 1;
    resetTurn(state, "p1");

    expect(state.blocksInTurn).toBe(0);
    expect(state.promptId).toBe("p1");
  });
});

describe("clearFailures", () => {
  test("resets the failing set, the diagnostics and the counter", () => {
    guard(state, { lint: ["a.ts"] }, { [diagnosticKey("lint", "a.ts")]: 1 }, CAP, "r");
    clearFailures(state);

    expect(state.lastFailing).toBeNull();
    expect(state.lastDiagnostics).toBeNull();
    expect(state.blocksInTurn).toBe(0);
  });
});

describe("failureKey and diagnosticKey", () => {
  test("failureKey ignores the order of files and lanes", () => {
    expect(failureKey({ lint: ["a.ts", "b.ts"], test: ["c.ts"] })).toBe(
      failureKey({ test: ["c.ts"], lint: ["b.ts", "a.ts"] }),
    );
  });

  test("failureKey differs for a different set", () => {
    expect(failureKey({ lint: ["a.ts"] })).not.toBe(failureKey({ test: ["a.ts"] }));
    expect(failureKey({ lint: ["a.ts"] })).not.toBe(failureKey({ lint: ["a.ts", "b.ts"] }));
  });

  test("diagnosticKey joins the lane and the file with a NUL", () => {
    expect(diagnosticKey("lint", "a.ts")).toBe("lint\u0000a.ts");
  });
});
