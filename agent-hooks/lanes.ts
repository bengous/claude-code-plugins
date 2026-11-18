import { existsSync } from "node:fs";
import path from "node:path";

import { isExcluded, matchesFilter, pkgOf, resolveArgv } from "./command.ts";
import type { Lane, LaneVerdict } from "./config.ts";
import type { Deadline, RunResult, Runner } from "./core/util/exec.ts";
import { formatFailure, outputOf, succeeded, tail } from "./core/util/exec.ts";
import { sha256 } from "./core/util/hash.ts";
import { escapeRegExp } from "./core/util/text.ts";
import type { Diagnostics, Failing, Failures } from "./guard.ts";
import { diagnosticKey } from "./guard.ts";
import type { LaneRun, LastRun } from "./state.ts";

const REASON_TAIL_LINES = 200;

export const PROJECT_FILE = "<project>";

export const FIX_INSTRUCTION = "Fix the errors above before stopping.";

export const REPORT_HEADERS: Readonly<Record<LaneVerdict, string>> = {
  block: "Stop validation failed:",
  note: "Stop notes, no block:",
};

type LaneGroup = {
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

export type LaneOptions = {
  readonly root: string;
  readonly runner: Runner;
  readonly deadline: Deadline;
  /** Green keys of the previous runs, or null to run every lane. */
  readonly green: Readonly<Record<string, string>> | null;
  readonly head: string | null;
  readonly digest: string;
  /** The config's `exclude`: generated or vendored files, never handed to a `files` lane. */
  readonly exclude: readonly string[];
};

function greenKey(
  lane: string,
  pkg: string,
  argv: readonly string[],
  options: LaneOptions,
): string {
  return sha256(`${lane}@${pkg}\n${argv.join("\0")}\n${options.head ?? ""}\n${options.digest}`);
}

export function greenSlot(lane: string, pkg: string): string {
  return `${lane}@${pkg}`;
}

/**
 * The scope files a lane takes: `on` minus `exclude`, and for a `files` lane only those still on disk and outside
 * the config's `exclude`. A `project` lane keeps the generated and vendored files: a change there can still break it.
 */
function selectFiles(lane: Lane, scope: readonly string[], options: LaneOptions): string[] {
  const selected = scope.filter((relativePath) => matchesFilter(lane, relativePath));

  return lane.takes === "files"
    ? selected.filter(
        (relativePath) =>
          existsSync(path.join(options.root, relativePath)) &&
          !isExcluded(options.exclude, relativePath),
      )
    : selected;
}

function groupsOf(lane: Lane, selected: readonly string[], root: string): LaneGroup[] {
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

/** Runs every group of every lane in parallel; a group green for the same key does not spawn. */
export function runLanes(
  lanes: readonly Lane[],
  scope: readonly string[],
  options: LaneOptions,
): Promise<LaneResult[]> {
  return Promise.all(
    lanes.flatMap((lane): Array<Promise<LaneResult>> => {
      const selected = selectFiles(lane, scope, options);

      if (selected.length === 0) {
        return [
          Promise.resolve({
            lane,
            pkg: ".",
            run: "skipped",
            output: "",
            key: null,
            failingFiles: [],
            diagnostics: {},
            ms: 0,
          }),
        ];
      }

      return groupsOf(lane, selected, options.root).map((group) => runGroup(lane, group, options));
    }),
  );
}

async function runGroup(lane: Lane, group: LaneGroup, options: LaneOptions): Promise<LaneResult> {
  const pkg = path.relative(options.root, group.pkg) || ".";

  const argv = resolveArgv(lane.run, {
    root: options.root,
    pkg: group.pkg,
    files: commandFiles(lane, group, options.root),
  });

  const base = { lane, pkg, key: null, failingFiles: [], diagnostics: {}, ms: 0 };

  if (argv.kind === "missing") {
    return {
      ...base,
      run: "missing",
      output: `command not found: ${argv.program}`,
      ...blame(lane, group, "", options.root),
    };
  }

  const key = greenKey(lane.name, pkg, argv.argv, options);

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

/** The paths a lane's command sees: relative to the package for a `pkg` lane, to the root otherwise. */
function commandFiles(lane: Lane, group: LaneGroup, root: string): string[] {
  return lane.cwd === "pkg"
    ? group.files.map((relativePath) => path.relative(group.pkg, path.join(root, relativePath)))
    : [...group.files];
}

/** Matches a path spelled whole in a line: `a.ts` must not match `src/ba.ts`. */
function pathPattern(spellings: readonly string[]): RegExp {
  const escaped = [...new Set(spellings)].map((spelling) => escapeRegExp(spelling));

  return new RegExp(String.raw`(?<![\w./-])(?:${escaped.join("|")})(?![\w-])`, "u");
}

export function isFailure(result: LaneResult): boolean {
  return result.run === "fail" || result.run === "timeout" || result.run === "missing";
}

export function failingOf(results: readonly LaneResult[]): Failures {
  const failing: Failing = {};
  const diagnostics: Diagnostics = {};

  for (const result of results.filter((candidate) => isFailure(candidate))) {
    failing[result.lane.name] = [
      ...new Set([...(failing[result.lane.name] ?? []), ...result.failingFiles]),
    ];
    Object.assign(diagnostics, result.diagnostics);
  }

  return { failing, diagnostics };
}

const SEVERITY: Readonly<Record<LaneRun, number>> = {
  skipped: 0,
  green: 1,
  ok: 2,
  missing: 3,
  timeout: 4,
  fail: 5,
};

/** One `LaneRun` per lane: the worst of its groups. */
export function laneRuns(results: readonly LaneResult[]): LastRun["lanes"] {
  const runs: LastRun["lanes"] = {};

  for (const result of results) {
    const current = runs[result.lane.name];

    runs[result.lane.name] =
      current === undefined || SEVERITY[result.run] > SEVERITY[current] ? result.run : current;
  }

  return runs;
}

/** The Stop report: the header of the verdict, then one `###` section per failing group. */
export function formatReport(failures: readonly LaneResult[], verdict: LaneVerdict): string {
  const groupCounts = new Map<string, number>();

  for (const result of failures) {
    groupCounts.set(result.lane.name, (groupCounts.get(result.lane.name) ?? 0) + 1);
  }

  const sections = failures.map((result) => {
    const title =
      (groupCounts.get(result.lane.name) ?? 0) > 1
        ? `### ${result.lane.name} [${result.pkg}]`
        : `### ${result.lane.name}`;

    return `${title}\n${result.output}`.trimEnd();
  });

  return [REPORT_HEADERS[verdict], ...sections].join("\n\n");
}

/** One line per lane run, its output indented: what `verify` prints. */
export function describe(result: LaneResult): string {
  const name = result.pkg === "." ? result.lane.name : `${result.lane.name} [${result.pkg}]`;
  const timing = result.ms > 0 ? ` (${result.ms} ms)` : "";
  const headline = `${name}: ${result.run}${timing}`;

  return result.output === ""
    ? headline
    : `${headline}\n${result.output
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n")}`;
}
