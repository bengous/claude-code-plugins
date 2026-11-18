import { existsSync } from "node:fs";
import path from "node:path";

import {
  dirtyDigest,
  dirtyTree,
  headSha,
  placeOf,
  rehashed,
  sessionFiles,
  wholeDirtyTree,
} from "./checkout.ts";
import { CONFIG_RELATIVE_PATH, ConfigError, DEFAULT_CAP, loadConfig } from "./config.ts";
import type { Deadline } from "./core/util/exec.ts";
import { fixScope } from "./fixers.ts";
import type { Diagnostics, Failing } from "./guard.ts";
import { KIT_LANE, clearFailures, guard, resetTurn } from "./guard.ts";
import type { HookOptions, Input, Verdict } from "./hook.ts";
import { ALLOW, raced } from "./hook.ts";
import type { LaneResult } from "./lanes.ts";
import {
  FIX_INSTRUCTION,
  failingOf,
  formatReport,
  greenSlot,
  isFailure,
  laneRuns,
  runLanes,
} from "./lanes.ts";
import { GitError } from "./lib/platform/git.ts";
import { messageOf } from "./lib/platform/pure.ts";
import type { SessionState } from "./state.ts";
import { freshState, persist, stateKey, statesOf } from "./state.ts";

const BUSY_TASK_TYPES = new Set(["subagent", "workflow", "teammate"]);

const ACTIVE_TASK_STATUSES = new Set(["running", "pending"]);

/** What one checkout's run leaves for its brake. */
type Outcome = {
  readonly state: SessionState;
  readonly cap: number;
  readonly failing: Failing;
  readonly diagnostics: Diagnostics;
  readonly block: string | null;
  readonly note: string | null;
};

/**
 * The Stop and the SubagentStop. Each checkout the agent is measured in yields the files it changed there: those that
 * differ from its photo, or the whole dirty tree without one. Its Stop fixers and lanes run on them under the
 * checkout's config, and one brake per checkout blocks while the agent makes progress on its failing set; the Stop
 * blocks if any brake does. Plan mode and a main session still waiting on a task end the turn in silence.
 */
export async function runStop(input: Input, options: HookOptions): Promise<Verdict | null> {
  if (input.permissionMode === "plan") {
    return null;
  }

  // A SubagentStop lists the stopping subagent itself among the running tasks: only the main session waits on them.
  const busy =
    input.agentId === undefined &&
    input.backgroundTasks.some(
      (task) => BUSY_TASK_TYPES.has(task.type) && ACTIVE_TASK_STATUSES.has(task.status),
    );

  if (busy) {
    return null;
  }

  const states = measuredStates(input, options.now);

  if (states.length === 0) {
    return null;
  }

  const cwdCheckout = input.cwd === undefined ? null : (placeOf(input.cwd)?.checkout ?? null);
  let verdict: Verdict;

  try {
    verdict = await raced("stop", options, async (deadline) => {
      const outcomes = await Promise.all(
        states.map((state) => measure(state, input, deadline, options, cwdCheckout)),
      );

      return merged(
        outcomes.map((outcome) => brake(outcome)),
        outcomes,
      );
    });
  } catch (error) {
    // A Stop that ran past its deadline blocks under the brake of the checkout around the cwd: it never ends silently.
    const message = `agent-hooks: ${messageOf(error)}`;
    const braked = states.find((state) => state.checkout === cwdCheckout) ?? states[0];

    verdict =
      braked === undefined
        ? ALLOW
        : guard(
            braked,
            { failing: { [KIT_LANE]: ["deadline"] }, diagnostics: {} },
            capOf(braked.checkout),
            message,
            "once-per-set",
          );
  }

  const unsaved = states.flatMap((state) => persist(state, options.now) ?? []);

  // The loop guard counts its blocks in the state: a block it could not record could repeat without end.
  if (verdict.kind === "block" && unsaved.length > 0) {
    return {
      kind: "note",
      text: `agent-hooks: the state could not be saved (${unsaved.join("; ")}), so the loop guard cannot count this block: letting the turn end\n${verdict.reason}`,
    };
  }

  return verdict;
}

/** The checkout's `cap`, or the default when its config does not read. */
function capOf(checkout: string): number {
  try {
    return loadConfig(path.join(checkout, CONFIG_RELATIVE_PATH)).cap;
  } catch {
    return DEFAULT_CAP;
  }
}

/**
 * What a failure of the kit is filed under in the failing set: its kind and subject, never its message, whose
 * numbers (a timeout's remaining time) change at each Stop and would read as progress.
 */
function kitFailureKey(error: Error | null): string {
  if (error instanceof ConfigError) {
    return "config";
  }

  if (error instanceof GitError) {
    return `git ${error.args.join(" ")} ${error.result.kind}`;
  }

  return error?.name ?? "error";
}

/**
 * The checkouts a Stop measures: each one the agent photographed, wherever its cwd has moved since, and for the main
 * session the checkout around its cwd, photographed or not: Bash photographs nothing, and checking too much beats
 * missing a change. A state without a photo belongs to a former cwd and is left alone once the cwd moved away: the
 * whole tree there is other sessions' work. A subagent keeps to what it photographed: over a shared checkout's whole
 * tree, one that edited nothing would block on its parent's work. A checkout gone from disk, or whose config is gone,
 * is left out.
 */
function measuredStates(input: Input, now: number): SessionState[] {
  const key = stateKey(input.sessionId, input.agentId);

  const cwdPlace =
    input.agentId === undefined && input.cwd !== undefined ? placeOf(input.cwd) : null;

  const measured = statesOf(key).filter(
    (state) =>
      existsSync(path.join(state.checkout, CONFIG_RELATIVE_PATH)) &&
      (state.photo !== null || state.checkout === cwdPlace?.checkout),
  );

  if (cwdPlace === null || measured.some((state) => state.checkout === cwdPlace.checkout)) {
    return measured;
  }

  return [...measured, freshState(key, cwdPlace.checkout, now)];
}

/**
 * One checkout's fixers and lanes on the agent's files there, its green keys and last run kept in its state. A
 * failure of the kit itself, an unreadable config or a git that failed or timed out, is a block of its own lane.
 */
async function measure(
  state: SessionState,
  input: Input,
  deadline: Deadline,
  options: HookOptions,
  cwdCheckout: string | null,
): Promise<Outcome> {
  resetTurn(state, input.promptId);

  // A report names its checkout unless it is the one around the cwd: the reader stands there already.
  const label = (text: string): string =>
    state.checkout === cwdCheckout ? text : `${state.checkout}:\n${text}`;

  try {
    return await measureLanes(state, deadline, options, label);
  } catch (error) {
    const message =
      error instanceof ConfigError ? error.message : `agent-hooks: ${messageOf(error)}`;

    return {
      state,
      cap: capOf(state.checkout),
      failing: { [KIT_LANE]: [kitFailureKey(error instanceof Error ? error : null)] },
      diagnostics: {},
      block: label(message),
      note: null,
    };
  }
}

async function measureLanes(
  state: SessionState,
  deadline: Deadline,
  options: HookOptions,
  label: (text: string) => string,
): Promise<Outcome> {
  const root = state.checkout;
  const config = loadConfig(path.join(root, CONFIG_RELATIVE_PATH));
  const tree = dirtyTree(root, deadline);
  const changed = state.photo === null ? wholeDirtyTree(tree) : sessionFiles(tree, state.photo);
  const fixOptions = { root, runner: options.runner, deadline };
  const fixed = await fixScope(config, changed, fixOptions);
  const started = Date.now();

  const results = await runLanes(config.lanes, changed, {
    ...fixOptions,
    green: state.green,
    head: headSha(root, deadline),
    digest: dirtyDigest(rehashed(tree, root, fixed)),
    exclude: config.exclude,
  });

  record(state, results, started);
  const failures = results.filter((result) => isFailure(result));
  const noted = failures.filter((result) => result.lane.verdict === "note");
  const blocking = failures.filter((result) => result.lane.verdict === "block");

  return {
    state,
    cap: config.cap,
    ...failingOf(blocking),
    block: blocking.length === 0 ? null : label(formatReport(blocking, "block")),
    note: noted.length === 0 ? null : label(formatReport(noted, "note")),
  };
}

function record(state: SessionState, results: readonly LaneResult[], started: number): void {
  state.lastRun = { at: started, ms: Date.now() - started, lanes: laneRuns(results) };

  // Only green results are cached: a red lane always re-runs, the agent is expected to be fixing it.
  for (const result of results) {
    if (result.run === "ok" && result.key !== null) {
      state.green[greenSlot(result.lane.name, result.pkg)] = result.key;
    }
  }
}

/**
 * The brake of one checkout: a block while the agent makes progress, at most `cap` times in a row; a checkout
 * without a photo blocks once per failing set.
 */
function brake(outcome: Outcome): Verdict {
  if (outcome.block === null) {
    clearFailures(outcome.state);

    return ALLOW;
  }

  return guard(
    outcome.state,
    outcome,
    outcome.cap,
    outcome.block,
    outcome.state.photo === null ? "once-per-set" : "progress",
  );
}

/** One verdict for the Stop: a block if any brake blocks, with the instruction once; else the notes, if any. */
function merged(verdicts: readonly Verdict[], outcomes: readonly Outcome[]): Verdict {
  const blocks = verdicts.flatMap((verdict) => (verdict.kind === "block" ? [verdict.reason] : []));

  const notes = [
    ...verdicts.flatMap((verdict) => (verdict.kind === "note" ? [verdict.text] : [])),
    ...outcomes.flatMap((outcome) => outcome.note ?? []),
  ];

  if (blocks.length > 0) {
    const reason = `${blocks.join("\n\n")}\n\n${FIX_INSTRUCTION}`;

    return {
      kind: "block",
      reason: notes.length === 0 ? reason : `${reason}\n${notes.join("\n")}`,
    };
  }

  return notes.length === 0 ? ALLOW : { kind: "note", text: notes.join("\n") };
}
