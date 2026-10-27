import type { SessionState } from "./state.ts";
import type { Verdict } from "./verdict.ts";

/** Lane name to the repo-relative files that failed in it. */
export type Failing = Record<string, readonly string[]>;

/** `diagnosticKey(lane, file)` to the number of output lines that name the file. */
export type Diagnostics = Record<string, number>;

export const CRASH_LANE = "agent-hooks";

const DIAGNOSTIC_SEPARATOR = "\u0000";

export function diagnosticKey(lane: string, file: string): string {
  return `${lane}${DIAGNOSTIC_SEPARATOR}${file}`;
}

/** A failing set with its diagnostics: what one Stop's blocking lanes left for the brake. */
export type Failures = { readonly failing: Failing; readonly diagnostics: Diagnostics };

/** The failures with each lane renamed: one brake over several roots tells their lanes apart. */
export function renamedLanes(
  failing: Failing,
  diagnostics: Diagnostics,
  rename: (lane: string) => string,
): Failures {
  return {
    failing: Object.fromEntries(
      Object.entries(failing).map(([lane, files]) => [rename(lane), files]),
    ),
    diagnostics: Object.fromEntries(
      Object.entries(diagnostics).map(([key, count]) => {
        const separator = key.indexOf(DIAGNOSTIC_SEPARATOR);

        return [diagnosticKey(rename(key.slice(0, separator)), key.slice(separator + 1)), count];
      }),
    ),
  };
}

/**
 * A new prompt starts a new turn: the consecutive-block counter restarts. The failing set and its diagnostics stay:
 * a set the agent left red in one turn only notes in the next, until it changes, so a red the agent cannot fix
 * never costs every turn its blocks.
 */
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
 * What counts as progress on an unchanged failing set. A photographed checkout measures the agent's own work, so
 * fewer diagnostic lines count; one without a photo cannot tell the agent's work from the dirt it found, so only a
 * changed set does, and it blocks at most once per set.
 */
export type Brake = "progress" | "once-per-set";

/**
 * Blocks while the agent makes progress on the failing set, at most `cap` times in a row; otherwise lets the turn
 * end with a note. Progress is a change of the failing set or, under the `progress` brake, fewer diagnostic lines
 * on the same set: line numbers move on every edit and never count.
 */
export function guard(
  state: SessionState,
  failing: Failing,
  diagnostics: Diagnostics,
  cap: number,
  reason: string,
  brake: Brake = "progress",
): Verdict {
  const progress =
    state.lastFailing === null ||
    failureKey(failing) !== failureKey(state.lastFailing) ||
    (brake === "progress" && total(diagnostics) < total(state.lastDiagnostics ?? {}));

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
