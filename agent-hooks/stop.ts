import path from "node:path";

import type { Fixer } from "./config.ts";
import { isExcluded } from "./config.ts";
import type { HookContext, Verdict } from "./hook.ts";
import { ALLOW } from "./hook.ts";
import type { FixOptions, LaneResult } from "./lanes.ts";
import {
  FIX_INSTRUCTION,
  failingOf,
  formatReport,
  greenSlot,
  isFailure,
  laneRuns,
  runFixers,
  runLanes,
  sequential,
} from "./lanes.ts";
import { clearFailures, guard, resetTurn } from "./loop-guard.ts";
import {
  dirtyDigest,
  dirtyTree,
  headSha,
  onDisk,
  rehashed,
  sessionFiles,
  wholeDirtyTree,
} from "./scope.ts";
import type { SessionState } from "./state.ts";

const BUSY_TASK_TYPES = new Set(["subagent", "workflow", "teammate"]);

const BUSY_TASK_STATUSES = new Set(["running", "pending"]);

/** The Stop gate: fixers then lanes on the session scope, a block only while the agent makes progress. */
export async function runStop(context: HookContext): Promise<Verdict> {
  const { input, state, config, root } = context;

  if (input.permissionMode === "plan") {
    return ALLOW;
  }

  // A SubagentStop lists the stopping subagent itself among the running tasks: only the main session waits on them.
  const busy =
    input.agentId === undefined
      ? input.backgroundTasks.find(
          (task) => BUSY_TASK_TYPES.has(task.type) && BUSY_TASK_STATUSES.has(task.status),
        )
      : undefined;

  if (busy !== undefined) {
    return {
      kind: "note",
      text: `agent-hooks: a ${busy.type} task is still running, lanes skipped`,
    };
  }

  resetTurn(state, input.promptId);
  const notes: string[] = [];

  if (state.photo === null) {
    notes.push("agent-hooks: no photo for this root, checking the whole dirty tree");

    // Without a photo there is no previous verdict to measure progress against: the one-shot flag is the only brake.
    if (input.stopHookActive) {
      return withNotes(ALLOW, notes);
    }
  }

  const tree = dirtyTree(root);

  if (tree === null) {
    return withNotes(
      { kind: "note", text: `agent-hooks: git status failed in ${root}, lanes skipped` },
      notes,
    );
  }

  const scope = state.photo === null ? wholeDirtyTree(tree) : sessionFiles(tree, state.photo);

  if (scope.length === 0) {
    clearFailures(state);

    return withNotes(ALLOW, notes);
  }

  const fixable = onDisk(root, scope).filter(
    (relativePath) => !isExcluded(config.preEdit.exclude, relativePath),
  );

  await fixScope(config.stop.fixers, fixable, context);
  const started = Date.now();

  const results = await runLanes(config.stop.lanes, scope, {
    ...context,
    green: state.green,
    head: headSha(root),
    digest: dirtyDigest(rehashed(tree, root, fixable)),
    exclude: config.preEdit.exclude,
  });

  recordRun(state, results, started);
  const failures = results.filter((result) => isFailure(result));
  const noted = failures.filter((result) => result.lane.verdict === "note");
  const blocking = failures.filter((result) => result.lane.verdict === "block");

  if (noted.length > 0) {
    notes.push(formatReport(noted, "note"));
  }

  if (blocking.length === 0) {
    clearFailures(state);

    return withNotes(ALLOW, notes);
  }

  const { failing, diagnostics } = failingOf(blocking);

  const verdict = guard(
    state,
    failing,
    diagnostics,
    config.stop.cap,
    formatReport(blocking, "block"),
  );

  // The guard may let the turn end with the same report: the instruction belongs to an actual block only.
  if (verdict.kind === "block") {
    return withNotes({ kind: "block", reason: `${verdict.reason}\n\n${FIX_INSTRUCTION}` }, notes);
  }

  return withNotes(verdict, notes);
}

async function fixScope(
  fixers: readonly Fixer[],
  scope: readonly string[],
  options: FixOptions,
): Promise<void> {
  if (fixers.length === 0) {
    return;
  }

  await sequential(scope, async (relativePath: string) => {
    const failures = await runFixers(
      fixers,
      { relativePath, file: path.join(options.root, relativePath) },
      options,
    );

    for (const failure of failures) {
      console.error(`agent-hooks: ${failure}`);
    }
  });
}

function recordRun(state: SessionState, results: readonly LaneResult[], started: number): void {
  state.lastRun = { at: started, ms: Date.now() - started, lanes: laneRuns(results) };

  // Only green results are cached: a red lane always re-runs, the agent is expected to be fixing it.
  for (const result of results) {
    if (result.run === "ok" && result.key !== null) {
      state.green[greenSlot(result.lane.name, result.pkg)] = result.key;
    }
  }
}

function withNotes(verdict: Verdict, notes: readonly string[]): Verdict {
  if (notes.length === 0) {
    return verdict;
  }

  const text = notes.join("\n");

  switch (verdict.kind) {
    case "allow": {
      return { kind: "note", text };
    }

    case "note": {
      return { kind: "note", text: `${verdict.text}\n${text}` };
    }

    case "block": {
      return { kind: "block", reason: `${verdict.reason}\n${text}` };
    }

    case "context":
    case "rewrite": {
      return verdict;
    }

    default: {
      const unreachable: never = verdict;
      throw new Error(`unhandled verdict: ${JSON.stringify(unreachable)}`);
    }
  }
}
