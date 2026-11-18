import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { isExcluded, matchesFilter, pkgOf, resolveArgv } from "./command.ts";
import type { Config, Fixer } from "./config.ts";
import type { Deadline, RunResult, Runner } from "./core/util/exec.ts";

/** One `--fix` pass drops the fixes that overlap; the next pass applies them. */
export const MAX_FIX_PASSES = 5;

export type FixTarget = {
  /** Checkout-relative path of the real file: what `{path}` and the globs see. */
  readonly relativePath: string;
  /** Absolute path the fixers rewrite: the real file, or pre-edit's scratch copy beside it. */
  readonly file: string;
};

export type FixOptions = {
  readonly root: string;
  readonly runner: Runner;
  readonly deadline: Deadline;
};

/**
 * The fixers of the config that run on `relativePath` at this moment, in declaration order: none on a file the
 * config's `exclude` names.
 */
export function fixersFor(config: Config, moment: "edit" | "stop", relativePath: string): Fixer[] {
  if (isExcluded(config.exclude, relativePath)) {
    return [];
  }

  return config.fixers.filter(
    (fixer) => (fixer.at === moment || fixer.at === "both") && matchesFilter(fixer, relativePath),
  );
}

/**
 * Runs the fixers on the target, the `loop` ones first until the content settles, then the others once. A fixer that
 * fails or is missing changes nothing and says nothing: `doctor` is where a broken fixer shows.
 */
export async function runFixers(
  fixers: readonly Fixer[],
  target: FixTarget,
  options: FixOptions,
): Promise<void> {
  const looping = fixers.filter((fixer) => fixer.loop);

  for (let pass = 0; looping.length > 0 && pass < MAX_FIX_PASSES; pass += 1) {
    const before = readTarget(target);

    for (const fixer of looping) {
      await runFixer(fixer, target, options);
    }

    if (readTarget(target) === before) {
      break;
    }
  }

  for (const fixer of fixers.filter((candidate) => !candidate.loop)) {
    await runFixer(fixer, target, options);
  }
}

/**
 * The Stop's fixers on the files of `scope` still on disk, one file after the other, each rewritten in place.
 * Returns the files a fixer ran on, whose content may have changed.
 */
export async function fixScope(
  config: Config,
  scope: readonly string[],
  options: FixOptions,
): Promise<string[]> {
  const fixed: string[] = [];

  for (const relativePath of scope) {
    const file = path.join(options.root, relativePath);
    const fixers = existsSync(file) ? fixersFor(config, "stop", relativePath) : [];

    if (fixers.length > 0) {
      fixed.push(relativePath);
      await runFixers(fixers, { relativePath, file }, options);
    }
  }

  return fixed;
}

/**
 * Runs one fixer on the target. A `stdin` fixer's output replaces the file only on exit 0 with a non-empty stdout,
 * and only while the file still holds what the fixer was given: a change made meanwhile is kept.
 */
export async function runFixer(
  fixer: Fixer,
  target: FixTarget,
  options: FixOptions,
): Promise<RunResult> {
  const pkg = pkgOf(options.root, target.relativePath);

  const argv = resolveArgv(fixer.run.command, {
    root: options.root,
    pkg,
    file: target.file,
    path: target.relativePath,
  });

  if (argv.kind === "missing") {
    return { kind: "missing", program: argv.program };
  }

  if (fixer.run.kind === "file") {
    return options.runner(argv.argv, {
      cwd: options.root,
      timeoutMs: options.deadline.remaining(),
    });
  }

  const given = readTarget(target) ?? "";

  const result = await options.runner(argv.argv, {
    cwd: options.root,
    timeoutMs: options.deadline.remaining(),
    stdin: given,
  });

  if (
    result.kind === "exited" &&
    result.code === 0 &&
    result.stdout !== "" &&
    readTarget(target) === given
  ) {
    // oxlint-disable-next-line local/no-raw-write -- the user's source keeps its mode, its symlink and its hard links, which a rename over it would drop
    writeFileSync(target.file, result.stdout);
  }

  return result;
}

function readTarget(target: FixTarget): string | null {
  try {
    return readFileSync(target.file, "utf8");
  } catch {
    return null;
  }
}
