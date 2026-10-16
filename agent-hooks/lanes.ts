import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Fixer, Lane, LaneVerdict } from "./config.ts";
import { expandCommand, isExcluded, matchesFilter, pkgOf } from "./config.ts";
import type { Argv, Deadline, RunOptions, RunResult, Runner } from "./exec.ts";
import { formatFailure, outputOf, resolveProgram, succeeded, tail } from "./exec.ts";
import type { Diagnostics, Failing } from "./loop-guard.ts";
import { diagnosticKey } from "./loop-guard.ts";
import { sha256 } from "./scope.ts";
import type { LaneRun, LastRun } from "./state.ts";

// One `--fix` pass drops the fixes that overlap; the next pass applies them.
export const MAX_FIX_PASSES = 5;

export const REASON_TAIL_LINES = 200;

export const PROJECT_FILE = "<project>";

export type FixTarget = {
  /** Repo-relative path of the real file: what `{path}` and the globs see. */
  readonly relativePath: string;
  /** Absolute path the fixers rewrite: the real file, or a temporary copy under pre-edit. */
  readonly file: string;
};

export type FixOptions = {
  readonly root: string;
  readonly runner: Runner;
  readonly deadline: Deadline;
};

export type LaneGroup = {
  readonly pkg: string;
  readonly files: readonly string[];
};

export type LaneResult = {
  readonly lane: Lane;
  /** Package directory relative to the root, "." for the root itself. */
  readonly pkg: string;
  readonly run: LaneRun;
  readonly output: string;
  readonly key: string | null;
  readonly failingFiles: readonly string[];
  readonly diagnostics: Diagnostics;
  readonly ms: number;
};

export type LaneOptions = FixOptions & {
  /** Green keys of the previous runs, or null to run every lane. */
  readonly green: Readonly<Record<string, string>> | null;
  readonly head: string | null;
  readonly digest: string;
  /** `pre-edit.exclude`: generated or vendored files, never handed to a `files` lane. */
  readonly exclude: readonly string[];
};

export function greenKey(
  lane: string,
  pkg: string,
  argv: Argv,
  head: string | null,
  digest: string,
): string {
  return sha256(`${lane}@${pkg}\n${argv.join("\0")}\n${head ?? ""}\n${digest}`);
}

export function greenSlot(lane: string, pkg: string): string {
  return `${lane}@${pkg}`;
}

/**
 * Runs the fixers that match the target, the looping ones first until the content settles, then the others once.
 * Returns the formatted failures of the non-looping fixers: a formatter on broken syntax, nearly always.
 */
export async function runFixers(
  fixers: readonly Fixer[],
  target: FixTarget,
  options: FixOptions,
): Promise<string[]> {
  const applicable = fixers.filter(
    (fixer) => !fixer.disabled && matchesFilter(fixer, target.relativePath),
  );

  const pkg = pkgOf(options.root, target.relativePath);
  const context: FixContext = { ...options, target, pkg };
  await runLoopPasses(
    applicable.filter((fixer) => fixer.loop),
    context,
    MAX_FIX_PASSES,
  );
  const failures: string[] = [];
  await sequential(
    applicable.filter((fixer) => !fixer.loop),
    async (fixer) => {
      const result = await runFixer(fixer, context);

      // A missing binary is a setup problem for `doctor`, not feedback for the agent.
      if (result !== null && result.kind !== "missing" && !succeeded(result)) {
        failures.push(formatFailure(fixer.name, result));
      }
    },
  );

  return failures;
}

type FixContext = FixOptions & {
  readonly target: FixTarget;
  readonly pkg: string;
};

async function runLoopPasses(
  fixers: readonly Fixer[],
  context: FixContext,
  passesLeft: number,
): Promise<void> {
  if (fixers.length === 0 || passesLeft === 0) {
    return;
  }

  const before = readTarget(context.target);
  await sequential(fixers, async (fixer) => {
    await runFixer(fixer, context);
  });

  if (readTarget(context.target) !== before) {
    await runLoopPasses(fixers, context, passesLeft - 1);
  }
}

function readTarget(target: FixTarget): string | null {
  try {
    return readFileSync(target.file, "utf8");
  } catch {
    return null;
  }
}

/** Runs one fixer; a `stdin` fixer's output replaces the file only on exit 0 with a non-empty stdout. */
async function runFixer(fixer: Fixer, context: FixContext): Promise<RunResult | null> {
  const command = fixer.file ?? fixer.stdin;

  if (command === undefined) {
    return null;
  }

  const vars = {
    root: context.root,
    pkg: context.pkg,
    file: context.target.file,
    path: context.target.relativePath,
  };

  const argv = resolveArgv(expandCommand(command, vars), context.pkg, context.root);

  if (argv.kind === "missing") {
    console.error(`agent-hooks: ${fixer.name}: command not found: ${argv.program}`);

    return { kind: "missing", program: argv.program };
  }

  const options: RunOptions =
    fixer.stdin === undefined
      ? { cwd: context.root, timeoutMs: context.deadline.remaining() }
      : {
          cwd: context.root,
          timeoutMs: context.deadline.remaining(),
          stdin: readTarget(context.target) ?? "",
        };

  const result = await context.runner(argv.argv, options);

  if (
    fixer.stdin !== undefined &&
    result.kind === "exited" &&
    result.code === 0 &&
    result.stdout !== ""
  ) {
    writeFileSync(context.target.file, result.stdout);
  }

  return result;
}

type ResolvedArgv =
  | { readonly kind: "ok"; readonly argv: Argv }
  | { readonly kind: "missing"; readonly program: string };

function resolveArgv(argv: Argv | null, pkg: string, root: string): ResolvedArgv {
  if (argv === null) {
    return { kind: "missing", program: "" };
  }

  const program = resolveProgram(argv[0], pkg, root);

  return program === null
    ? { kind: "missing", program: argv[0] }
    : { kind: "ok", argv: [program, ...argv.slice(1)] };
}

export async function sequential<T>(
  items: readonly T[],
  action: (item: T) => Promise<void>,
): Promise<void> {
  const [first, ...rest] = items;

  if (first === undefined) {
    return;
  }

  await action(first);
  await sequential(rest, action);
}

/**
 * The scope files a lane takes: `on` minus `exclude`, and for a `files` lane only those still on disk and outside
 * `preEditExclude`. A `project` lane keeps the generated and vendored files: a change there can still break it.
 */
export function selectFiles(
  lane: Lane,
  scope: readonly string[],
  root: string,
  preEditExclude: readonly string[] = [],
): string[] {
  const selected = scope.filter((relativePath) => matchesFilter(lane, relativePath));

  return lane.takes === "files"
    ? selected.filter(
        (relativePath) =>
          existsSync(path.join(root, relativePath)) && !isExcluded(preEditExclude, relativePath),
      )
    : selected;
}

export function groupsOf(lane: Lane, selected: readonly string[], root: string): LaneGroup[] {
  if (lane.cwd === "root") {
    return [{ pkg: path.resolve(root), files: selected }];
  }

  const groups = new Map<string, string[]>();

  for (const relativePath of selected) {
    const pkg = pkgOf(root, relativePath);
    groups.set(pkg, [...(groups.get(pkg) ?? []), relativePath]);
  }

  return [...groups].map(([pkg, files]) => ({ pkg, files }));
}

/** Runs every group of every enabled lane in parallel; a cached green group does not spawn. */
export function runLanes(
  lanes: readonly Lane[],
  scope: readonly string[],
  options: LaneOptions,
): Promise<LaneResult[]> {
  const jobs = lanes
    .filter((lane) => !lane.disabled)
    .flatMap((lane): Array<Promise<LaneResult>> => {
      const selected = selectFiles(lane, scope, options.root, options.exclude);

      if (selected.length === 0) {
        return [Promise.resolve(skipped(lane))];
      }

      return groupsOf(lane, selected, options.root).map((group) => runGroup(lane, group, options));
    });

  return Promise.all(jobs);
}

function skipped(lane: Lane): LaneResult {
  return {
    lane,
    pkg: ".",
    run: "skipped",
    output: "",
    key: null,
    failingFiles: [],
    diagnostics: {},
    ms: 0,
  };
}

async function runGroup(lane: Lane, group: LaneGroup, options: LaneOptions): Promise<LaneResult> {
  const pkg = path.relative(options.root, group.pkg) || ".";

  const argv = resolveArgv(
    expandCommand(lane.run, {
      root: options.root,
      pkg: group.pkg,
      files: commandFiles(lane, group, options.root),
    }),
    group.pkg,
    options.root,
  );

  const base = { lane, pkg, key: null, failingFiles: [], diagnostics: {}, ms: 0 };

  if (argv.kind === "missing") {
    return {
      ...base,
      run: "missing",
      output: `command not found: ${argv.program}`,
      ...blame(lane, group, "", options.root),
    };
  }

  const key = greenKey(lane.name, pkg, argv.argv, options.head, options.digest);

  if (options.green?.[greenSlot(lane.name, pkg)] === key) {
    return { ...base, run: "green", output: "", key };
  }

  const started = Date.now();

  const result = await options.runner(argv.argv, {
    cwd: lane.cwd === "pkg" ? group.pkg : options.root,
    timeoutMs: Math.min(lane.timeoutMs, options.deadline.remaining()),
  });

  const ms = Date.now() - started;

  if (succeeded(result)) {
    return { ...base, run: "ok", output: "", key, ms };
  }

  const output =
    result.kind === "timedOut"
      ? formatFailure(lane.name, result)
      : tail(outputOf(result), REASON_TAIL_LINES);

  return {
    ...base,
    run: failedRun(result),
    output,
    key,
    ms,
    ...blame(lane, group, output, options.root),
  };
}

function failedRun(result: RunResult): LaneRun {
  switch (result.kind) {
    case "timedOut": {
      return "timeout";
    }

    case "missing": {
      return "missing";
    }

    case "exited": {
      return "fail";
    }

    default: {
      const unreachable: never = result;
      throw new Error(`unhandled result: ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * The files to blame: those of the group the output names, else the whole group for a `files` lane, else the
 * project. Diagnostics count the output lines that name each file.
 */
function blame(
  lane: Lane,
  group: LaneGroup,
  output: string,
  root: string,
): Pick<LaneResult, "failingFiles" | "diagnostics"> {
  const lines = output.split(/\r?\n/u);
  const diagnostics: Diagnostics = {};
  const spellings = commandFiles(lane, group, root);

  for (const [index, relativePath] of group.files.entries()) {
    const pattern = pathPattern([relativePath, spellings[index] ?? relativePath]);
    const count = lines.filter((line) => pattern.test(line)).length;

    if (count > 0) {
      diagnostics[diagnosticKey(lane.name, relativePath)] = count;
    }
  }

  const mentioned = group.files.filter(
    (relativePath) => diagnosticKey(lane.name, relativePath) in diagnostics,
  );

  if (mentioned.length > 0) {
    return { failingFiles: mentioned, diagnostics };
  }

  return { failingFiles: lane.takes === "files" ? [...group.files] : [PROJECT_FILE], diagnostics };
}

/** The paths a lane's command sees: relative to the crate for a `pkg` lane, to the root otherwise. */
function commandFiles(lane: Lane, group: LaneGroup, root: string): string[] {
  return lane.cwd === "pkg"
    ? group.files.map((relativePath) => path.relative(group.pkg, path.join(root, relativePath)))
    : [...group.files];
}

/** Matches a path spelled whole in a line: `a.ts` must not match `src/ba.ts`. */
function pathPattern(spellings: readonly string[]): RegExp {
  const escaped = [...new Set(spellings)].map((spelling) =>
    spelling.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`),
  );

  return new RegExp(String.raw`(?<![\w./-])(?:${escaped.join("|")})(?![\w-])`, "u");
}

export function isFailure(result: LaneResult): boolean {
  return result.run === "fail" || result.run === "timeout" || result.run === "missing";
}

export type FailureSummary = { readonly failing: Failing; readonly diagnostics: Diagnostics };

export function failingOf(results: readonly LaneResult[]): FailureSummary {
  const failing: Failing = {};
  const diagnostics: Diagnostics = {};

  for (const result of results) {
    if (!isFailure(result)) {
      continue;
    }

    failing[result.lane.name] = [
      ...new Set([...(failing[result.lane.name] ?? []), ...result.failingFiles]),
    ];
    Object.assign(diagnostics, result.diagnostics);
  }

  return { failing, diagnostics };
}

/** One `LaneRun` per lane: `fail` as soon as one group fails, `green` or `ok` only when every group is. */
export function laneRuns(results: readonly LaneResult[]): LastRun["lanes"] {
  const runs: LastRun["lanes"] = {};

  for (const result of results) {
    const current = runs[result.lane.name];
    runs[result.lane.name] = current === undefined ? result.run : worse(current, result.run);
  }

  return runs;
}

const SEVERITY: Readonly<Record<LaneRun, number>> = {
  skipped: 0,
  green: 1,
  ok: 2,
  missing: 3,
  timeout: 4,
  fail: 5,
};

function worse(left: LaneRun, right: LaneRun): LaneRun {
  return SEVERITY[left] >= SEVERITY[right] ? left : right;
}

export const FIX_INSTRUCTION = "Fix the errors above before stopping.";

const REPORT_HEADERS: Readonly<Record<LaneVerdict, string>> = {
  block: "Stop validation failed:",
  note: "Stop notes, no block:",
};

/** The Stop report: the header of the verdict, then one `###` section per failing group. */
export function formatReport(failures: readonly LaneResult[], verdict: LaneVerdict): string {
  const groupCounts = new Map<string, number>();

  for (const result of failures) {
    groupCounts.set(result.lane.name, (groupCounts.get(result.lane.name) ?? 0) + 1);
  }

  const multiPkg = new Set([...groupCounts].flatMap(([name, count]) => (count > 1 ? [name] : [])));

  const sections = failures.map((result) => {
    const title = multiPkg.has(result.lane.name)
      ? `### ${result.lane.name} [${result.pkg}]`
      : `### ${result.lane.name}`;

    return `${title}\n${result.output}`.trimEnd();
  });

  return [REPORT_HEADERS[verdict], ...sections].join("\n\n");
}
