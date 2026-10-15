import type { Verdict } from "./hook.ts";
import type { SessionState } from "./state.ts";

/** Lane name to the repo-relative files that failed in it. */
export type Failing = Record<string, readonly string[]>;

/** `diagnosticKey(lane, file)` to the number of output lines that name the file. */
export type Diagnostics = Record<string, number>;

export const CRASH_LANE = "agent-hooks";

export function diagnosticKey(lane: string, file: string): string {
  return `${lane}\u0000${file}`;
}

/** A new prompt starts a new turn: the consecutive-block counter restarts. */
export function resetTurn(state: SessionState, promptId: string | undefined): void {
  if (promptId !== undefined && promptId !== state.promptId) {
    state.blocksInTurn = 0;
    state.promptId = promptId;
  }
}

export function clearFailures(state: SessionState): void {
  state.lastFailing = null;
  state.lastDiagnostics = null;
  state.blocksInTurn = 0;
}

/**
 * Blocks while the agent makes progress on the failing set, at most `cap` times in a row; otherwise lets the turn
 * end with a note. Progress is a change of the failing set or fewer diagnostic lines on the same set: line numbers
 * move on every edit and never count.
 */
export function guard(
  state: SessionState,
  failing: Failing,
  diagnostics: Diagnostics,
  cap: number,
  reason: string,
): Verdict {
  const progress =
    state.lastFailing === null ||
    failureKey(failing) !== failureKey(state.lastFailing) ||
    total(diagnostics) < total(state.lastDiagnostics ?? {});

  state.lastFailing = failing;
  state.lastDiagnostics = diagnostics;

  if (!progress) {
    return {
      kind: "note",
      text: `agent-hooks: same failures as the previous Stop, letting the turn end\n${reason}`,
    };
  }

  if (state.blocksInTurn >= cap) {
    return {
      kind: "note",
      text: `agent-hooks: ${cap} blocks in a row, letting the turn end\n${reason}`,
    };
  }

  state.blocksInTurn += 1;

  return { kind: "block", reason };
}

export function failureKey(failing: Failing): string {
  return Object.entries(failing)
    .map(([lane, files]) => `${lane}:${[...files].toSorted().join(",")}`)
    .toSorted()
    .join("\n");
}

function total(diagnostics: Diagnostics): number {
  return Object.values(diagnostics).reduce((sum, count) => sum + count, 0);
}
