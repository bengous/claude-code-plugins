import { existsSync } from "node:fs";
import path from "node:path";

import type { Config } from "./config.ts";
import { isExcluded } from "./config.ts";
import type { Runner } from "./exec.ts";
import { deadlineIn, run } from "./exec.ts";
import type { LaneResult } from "./lanes.ts";
import { isFailure, runFixers, runLanes, sequential } from "./lanes.ts";
import type { DirtyTree } from "./scope.ts";
import {
  DELETED,
  checkoutOf,
  dirtyDigest,
  dirtyTree,
  headSha,
  onDisk,
  ownedByRoot,
  realPathOf,
  rehashed,
  rootView,
  sessionFiles,
  underRoot,
  wholeDirtyTree,
} from "./scope.ts";
import { latestStateForCheckout } from "./state.ts";

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

/**
 * The Stop lanes on demand, without the green cache or the hook deadline; the state is read, never written. The
 * scope is the Stop's for this root: the files it owns among those the last main session changed in the checkout,
 * or among the whole dirty tree, or the files named.
 */
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

  const checkout = checkoutOf(options.root) ?? options.root;
  const tree = dirtyTree(checkout);

  if (tree === null) {
    print(`agent-hooks: git status failed in ${checkout}`);

    return { scope: [], results: [], exitCode: 1 };
  }

  // A named file must be on disk or a deletion git knows: anything else is a typo, not an empty check.
  const unknown = options.files.filter((file) => {
    const absolute = realPathOf(path.resolve(options.cwd, file));

    return !existsSync(absolute) && tree.get(underRoot(checkout, absolute) ?? "") !== DELETED;
  });

  if (unknown.length > 0) {
    for (const file of unknown) {
      print(`agent-hooks: no such file: ${file}`);
    }

    return { scope: [], results: [], exitCode: 1 };
  }

  const scope = verifyScope(options, checkout, tree);
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
    head: headSha(checkout),
    digest: dirtyDigest(rehashed(rootView(tree, checkout, options.root), options.root, fixable)),
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
  return underRoot(options.root, realPathOf(path.resolve(options.cwd, file)));
}

function verifyScope(options: VerifyOptions, checkout: string, tree: DirtyTree): string[] {
  // A named file git knows as deleted stays in the scope, as at Stop: a project lane still runs on it.
  if (options.files.length > 0) {
    return options.files.flatMap((file) => rootRelative(options, file) ?? []).toSorted();
  }

  const photo = options.all ? null : (latestStateForCheckout(checkout)?.photo ?? null);
  const changed = photo === null ? wholeDirtyTree(tree) : sessionFiles(tree, photo);

  return [...(ownedByRoot(checkout, changed).get(options.root) ?? [])];
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
