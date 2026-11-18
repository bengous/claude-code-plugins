import { existsSync } from "node:fs";
import path from "node:path";

import type { Place } from "./checkout.ts";
import {
  dirtyDigest,
  dirtyTree,
  headSha,
  realPathOf,
  rehashed,
  sessionFiles,
  underCheckout,
  wholeDirtyTree,
} from "./checkout.ts";
import { loadConfig } from "./config.ts";
import type { Runner } from "./core/util/exec.ts";
import { deadlineIn, run } from "./core/util/exec.ts";
import { DELETED } from "./core/util/hash.ts";
import { fixScope } from "./fixers.ts";
import { describe, isFailure, runLanes } from "./lanes.ts";
import { latestMainState } from "./state.ts";

export type VerifyOptions = {
  readonly place: Place;
  /** The directory the `files` are relative to: the caller's working directory. */
  readonly cwd: string;
  readonly all: boolean;
  readonly files: readonly string[];
  readonly runner?: Runner;
  readonly print?: (line: string) => void;
};

const NO_DEADLINE_MS = 60 * 60 * 1000;

/**
 * The Stop's fixers and lanes on demand, without the green cache or the hook deadline; the state is read, never
 * written. The scope is the files the last main session changed in the checkout, the whole dirty tree with `all`, or
 * the files named. Returns the exit code: 1 when a blocking lane fails.
 */
export async function runVerify(options: VerifyOptions): Promise<number> {
  const print = options.print ?? console.log;
  const { checkout } = options.place;
  const config = loadConfig(options.place.configFile);
  const deadline = deadlineIn(NO_DEADLINE_MS);
  const tree = dirtyTree(checkout, deadline);
  const named = options.files.map((file) => realPathOf(path.resolve(options.cwd, file)));
  const outside = named.filter((absolute) => underCheckout(checkout, absolute) === null);

  // A named file must be on disk or a deletion git knows: anything else is a typo, not an empty check.
  const unknown = named.filter(
    (absolute) =>
      !existsSync(absolute) && tree.get(underCheckout(checkout, absolute) ?? "") !== DELETED,
  );

  for (const absolute of outside) {
    print(`agent-hooks: ${absolute} is outside ${checkout}`);
  }

  for (const absolute of unknown.filter((file) => !outside.includes(file))) {
    print(`agent-hooks: no such file: ${absolute}`);
  }

  if (outside.length > 0 || unknown.length > 0) {
    return 1;
  }

  const photo = options.all ? null : (latestMainState(checkout)?.photo ?? null);

  const scope =
    named.length > 0
      ? named.flatMap((absolute) => underCheckout(checkout, absolute) ?? []).toSorted()
      : photo === null
        ? wholeDirtyTree(tree)
        : sessionFiles(tree, photo);

  print(`scope: ${scope.length === 0 ? "(empty)" : scope.join(" ")}`);
  const fixOptions = { root: checkout, runner: options.runner ?? run, deadline };
  const fixed = await fixScope(config, scope, fixOptions);

  const results = await runLanes(config.lanes, scope, {
    ...fixOptions,
    green: null,
    head: headSha(checkout, deadline),
    digest: dirtyDigest(rehashed(tree, checkout, fixed)),
    exclude: config.exclude,
  });

  for (const result of results) {
    print(describe(result));
  }

  return results.some((result) => isFailure(result) && result.lane.verdict === "block") ? 1 : 0;
}
