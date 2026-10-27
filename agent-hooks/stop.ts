import path from "node:path";

import { isExcluded } from "./command.ts";
import type { Config, Fixer } from "./config.ts";
import { DEFAULT_CAP, loadConfig } from "./config.ts";
import type { StopContext } from "./hook.ts";
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
import type { Diagnostics, Failing } from "./loop-guard.ts";
import { CRASH_LANE, clearFailures, guard, renamedLanes, resetTurn } from "./loop-guard.ts";
import { ConfigError } from "./reader.ts";
import type { DirtyTree } from "./scope.ts";
import {
  dirtyDigest,
  dirtyTree,
  findRoot,
  headSha,
  onDisk,
  ownedByRoot,
  rehashed,
  rootView,
  sessionFiles,
  wholeDirtyTree,
} from "./scope.ts";
import type { RootRecord, SessionState } from "./state.ts";
import { rootName, rootRecord } from "./state.ts";
import type { Verdict } from "./verdict.ts";
import { ALLOW } from "./verdict.ts";

const BUSY_TASK_TYPES = new Set(["subagent", "workflow", "teammate"]);

const BUSY_TASK_STATUSES = new Set(["running", "pending"]);

/** One checkout of the Stop: the agent's state there, its dirty tree, and the files the agent changed. */
type Measured = {
  readonly state: SessionState;
  readonly tree: DirtyTree;
  readonly changed: readonly string[];
};

/** One root's run: the checkout it reads and the changed files it owns there, relative to the root. */
type RootJob = {
  readonly root: string;
  readonly checkout: Measured;
  readonly files: readonly string[];
};

/** What one root's run leaves for its checkout's brake: its failing set, its cap, and its reports. */
type RootOutcome = {
  readonly state: SessionState;
  readonly cap: number;
  readonly failing: Failing;
  readonly diagnostics: Diagnostics;
  readonly block: string | null;
  readonly note: string | null;
};

/**
 * The Stop gate. Each checkout the Stop measures yields the files the agent changed there: those differing from its
 * photo, or its whole dirty tree without one. Each changed file goes to the nearest root holding the config, and
 * the roots owning at least one file run their fixers and lanes on their own files. One brake per checkout blocks
 * while the agent makes progress on its failing set; the Stop blocks if any brake does.
 */
export async function runStop(context: StopContext): Promise<Verdict> {
  const { input, checkouts } = context;

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

  const notes: string[] = [];
  const measured: Measured[] = [];

  for (const state of checkouts) {
    resetTurn(state, input.promptId);
    const tree = dirtyTree(state.checkout);

    // A root outside git has nothing to measure; doctor says so once, the Stop stays silent.
    if (tree === null) {
      continue;
    }

    if (state.photo === null) {
      notes.push(`agent-hooks: no photo of ${state.checkout}, checking its whole dirty tree`);
    }

    measured.push({
      state,
      tree,
      changed: state.photo === null ? wholeDirtyTree(tree) : sessionFiles(tree, state.photo),
    });
  }

  const jobs = measured.flatMap((checkout) =>
    [...ownedByRoot(checkout.state.checkout, checkout.changed)].map(([root, files]): RootJob => ({
      root,
      checkout,
      files,
    })),
  );

  // A report names its root unless that root is the one around the cwd: the reader stands there already.
  const cwdRoot = input.cwd === undefined ? null : findRoot(input.cwd);
  const outcomes = await Promise.all(jobs.map((job) => runRoot(job, context, cwdRoot)));

  const verdicts = measured.map((checkout) =>
    brake(
      checkout.state,
      outcomes.filter((outcome) => outcome.state === checkout.state),
      notes,
    ),
  );

  return merged(verdicts, notes);
}

/** One root's fixers and lanes on the files it owns, its green keys and last run kept in its checkout's state. */
async function runRoot(
  job: RootJob,
  context: StopContext,
  cwdRoot: string | null,
): Promise<RootOutcome> {
  const { root, files } = job;
  const { state, tree } = job.checkout;
  const name = rootName(state.checkout, root);
  const label = (text: string): string => (root === cwdRoot ? text : `${root}:\n${text}`);
  let config: Config;

  try {
    config = loadConfig(root);
  } catch (error) {
    const message = error instanceof ConfigError ? error.message : `agent-hooks: ${String(error)}`;

    return {
      state,
      cap: DEFAULT_CAP,
      ...renamedLanes({ [CRASH_LANE]: [message] }, {}, (lane) => path.join(name, lane)),
      block: label(message),
      note: null,
    };
  }

  const fixable = onDisk(root, files).filter(
    (relativePath) => !isExcluded(config.preEdit.exclude, relativePath),
  );

  const fixOptions: FixOptions = { root, runner: context.runner, deadline: context.deadline };
  await fixScope(config.stop.fixers, fixable, fixOptions);
  const started = Date.now();
  const record = rootRecord(state, root);

  const results = await runLanes(config.stop.lanes, files, {
    ...fixOptions,
    green: record.green,
    head: headSha(state.checkout),
    digest: dirtyDigest(rehashed(rootView(tree, state.checkout, root), root, fixable)),
    exclude: config.preEdit.exclude,
  });

  recordRun(record, results, started);
  const failures = results.filter((result) => isFailure(result));
  const noted = failures.filter((result) => result.lane.verdict === "note");
  const blocking = failures.filter((result) => result.lane.verdict === "block");
  const { failing, diagnostics } = failingOf(blocking);

  return {
    state,
    cap: config.stop.cap,
    // A lane is named by its root, `packages/x/lint`, so one brake tells two roots' lanes apart.
    ...renamedLanes(failing, diagnostics, (lane) => path.join(name, lane)),
    block: blocking.length === 0 ? null : label(formatReport(blocking, "block")),
    note: noted.length === 0 ? null : label(formatReport(noted, "note")),
  };
}

/**
 * The brake of one checkout, over the failures of every root that ran there: a block while the agent makes progress,
 * at most the smallest cap of the failing roots in a row; a checkout without a photo blocks once per failing set.
 */
function brake(state: SessionState, outcomes: readonly RootOutcome[], notes: string[]): Verdict {
  notes.push(...outcomes.flatMap((outcome) => outcome.note ?? []));
  const blocking = outcomes.filter((outcome) => outcome.block !== null);

  if (blocking.length === 0) {
    clearFailures(state);

    return ALLOW;
  }

  return guard(
    state,
    Object.assign({}, ...blocking.map((outcome) => outcome.failing)),
    Object.assign({}, ...blocking.map((outcome) => outcome.diagnostics)),
    Math.min(...blocking.map((outcome) => outcome.cap)),
    blocking.flatMap((outcome) => outcome.block ?? []).join("\n\n"),
    state.photo === null ? "once-per-set" : "progress",
  );
}

/** One verdict for the Stop: a block if any brake blocks, with the instruction once; else the notes, if any. */
function merged(verdicts: readonly Verdict[], notes: readonly string[]): Verdict {
  const blocks = verdicts.flatMap((verdict) => (verdict.kind === "block" ? [verdict.reason] : []));

  const texts = [
    ...verdicts.flatMap((verdict) => (verdict.kind === "note" ? [verdict.text] : [])),
    ...notes,
  ];

  if (blocks.length > 0) {
    const reason = `${blocks.join("\n\n")}\n\n${FIX_INSTRUCTION}`;

    return {
      kind: "block",
      reason: texts.length === 0 ? reason : `${reason}\n${texts.join("\n")}`,
    };
  }

  return texts.length === 0 ? ALLOW : { kind: "note", text: texts.join("\n") };
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

function recordRun(record: RootRecord, results: readonly LaneResult[], started: number): void {
  record.lastRun = { at: started, ms: Date.now() - started, lanes: laneRuns(results) };

  // Only green results are cached: a red lane always re-runs, the agent is expected to be fixing it.
  for (const result of results) {
    if (result.run === "ok" && result.key !== null) {
      record.green[greenSlot(result.lane.name, result.pkg)] = result.key;
    }
  }
}
