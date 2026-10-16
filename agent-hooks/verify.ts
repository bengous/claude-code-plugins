import path from "node:path";

import type { Config } from "./config.ts";
import { isExcluded } from "./config.ts";
import type { Runner } from "./exec.ts";
import { deadlineIn, run } from "./exec.ts";
import type { LaneResult } from "./lanes.ts";
import { isFailure, runFixers, runLanes, sequential } from "./lanes.ts";
import { dirtyDigest, headSha, onDisk, sessionFiles, wholeDirtyTree } from "./scope.ts";
import { latestStateForRoot } from "./state.ts";

export type VerifyOptions = {
  readonly root: string;
  /** The directory the `files` are relative to: the caller's working directory. */
  readonly cwd: string;
  readonly config: Config;
  readonly all: boolean;
  readonly files: readonly string[];
  readonly runner?: Runner;
  readonly print?: (line: string) => void;
};

export type VerifyReport = {
  readonly scope: readonly string[];
  readonly results: readonly LaneResult[];
  readonly exitCode: number;
};

const NO_DEADLINE_MS = 60 * 60 * 1000;

/** The Stop lanes on demand, without the green cache or the hook deadline; the state is read, never written. */
export async function runVerify(options: VerifyOptions): Promise<VerifyReport> {
  const print = options.print ?? console.log;
  const runner = options.runner ?? run;
  const outside = options.files.filter((file) => rootRelative(options, file) === null);

  if (outside.length > 0) {
    for (const file of outside) {
      print(`agent-hooks: ${file} is outside ${options.root}`);
    }

    return { scope: [], results: [], exitCode: 1 };
  }

  const scope = verifyScope(options);

  if (scope === null) {
    print(`agent-hooks: git status failed in ${options.root}`);

    return { scope: [], results: [], exitCode: 1 };
  }

  print(`scope: ${scope.length === 0 ? "(empty)" : scope.join(" ")}`);
  const fixOptions = { root: options.root, runner, deadline: deadlineIn(NO_DEADLINE_MS) };

  const fixable = onDisk(options.root, scope).filter(
    (relativePath) => !isExcluded(options.config.preEdit.exclude, relativePath),
  );

  await sequential(fixable, async (relativePath: string) => {
    await runFixers(
      options.config.stop.fixers,
      { relativePath, file: path.join(options.root, relativePath) },
      fixOptions,
    );
  });

  const results = await runLanes(options.config.stop.lanes, scope, {
    ...fixOptions,
    green: null,
    head: headSha(options.root),
    digest: dirtyDigest(options.root),
    exclude: options.config.preEdit.exclude,
  });

  for (const result of results) {
    print(describe(result));
  }

  const blocked = results.some((result) => isFailure(result) && result.lane.verdict === "block");

  return { scope, results, exitCode: blocked ? 1 : 0 };
}

/** The file, named from the caller's directory, as a path under the root; null when it lies outside. */
function rootRelative(options: VerifyOptions, file: string): string | null {
  const relative = path.relative(path.resolve(options.root), path.resolve(options.cwd, file));

  return relative === "" || relative.startsWith("..") || path.isAbsolute(relative)
    ? null
    : relative;
}

function verifyScope(options: VerifyOptions): string[] | null {
  // A named file gone from disk stays in the scope, as a deleted file does at Stop: a project lane still runs.
  if (options.files.length > 0) {
    return options.files.flatMap((file) => rootRelative(options, file) ?? []).toSorted();
  }

  if (options.all) {
    return wholeDirtyTree(options.root);
  }

  const photo = latestStateForRoot(options.root)?.photo ?? null;

  return photo === null ? wholeDirtyTree(options.root) : sessionFiles(options.root, photo);
}

export function describe(result: LaneResult): string {
  const name = result.pkg === "." ? result.lane.name : `${result.lane.name} [${result.pkg}]`;
  const timing = result.ms > 0 ? ` (${result.ms} ms)` : "";
  const headline = `${name}: ${result.run}${timing}`;

  return result.output === "" ? headline : `${headline}\n${indent(result.output)}`;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}
