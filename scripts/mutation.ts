#!/usr/bin/env bun

/**
 * Mutation testing on the lines a change alters, in the modules `stryker.config.ts` lists: Stryker
 * mutates each changed module whole, in a pass of its own against the `.test.ts` beside it alone,
 * and a survivor whose lines meet a changed line fails, named with its file, line, mutator and
 * replacement. A whole module, since Stryker keeps a mutant only when its whole node lies inside a
 * line range: a block or a condition that spans past a changed line would go untested.
 *
 *   bun ./scripts/mutation.ts run             Stryker on each changed module; a survivor on a changed line exits 1
 *   bun ./scripts/mutation.ts github-output   `mutate=true` when a listed module has a changed line
 *
 * The change is the working tree against its merge-base with the base `affected.ts` resolves; on
 * an Actions push, the commit the push moved the branch from; on any other Actions run, `origin/dev`. Stryker is imported only once a changed line
 * asks for it, so CI installs it only then.
 */

import { appendFile, chmod, stat } from "node:fs/promises";
import { join } from "node:path";

import type { Stryker } from "@stryker-mutator/core";
import { $ } from "bun";

import config from "../stryker.config.ts";
import { baseOf, DEFAULT_BASE, type Env, mergeBaseWith } from "./affected.ts";

export interface LineRange {
  readonly file: string;
  readonly start: number;
  readonly end: number;
}

type MutantResult = Awaited<ReturnType<Stryker["runMutationTest"]>>[number];

export type Mutant = Pick<
  MutantResult,
  "fileName" | "location" | "mutatorName" | "replacement" | "status"
>;

const COMMANDS = ["run", "github-output"] as const;

type Command = (typeof COMMANDS)[number];

const UNDETECTED = new Set(["Survived", "NoCoverage"]);

/**
 * The lines each file gains or rewrites in a `git diff -U0` whose new side is prefixed `b/`. A file's
 * header runs from its `diff --git` line to its first hunk: past it, `+++ b/…` is an added line. A
 * deleted file's new side is `/dev/null`, and its hunks add no line.
 */
export function changedRanges(diff: string): LineRange[] {
  const ranges: LineRange[] = [];
  let file = "";
  let inHeader = false;

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) inHeader = true;

    if (inHeader && line.startsWith("+++ b/")) file = line.slice("+++ b/".length);
    const hunk = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/u.exec(line);

    if (hunk === null) continue;
    inHeader = false;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);

    if (count > 0) ranges.push({ file, start, end: start + count - 1 });
  }

  return ranges;
}

export function rangeLabel(range: LineRange): string {
  return `${range.file}:${range.start}-${range.end}`;
}

/** The modules the ranges fall in, each once, in the order they first appear. */
export function modulesOf(ranges: readonly LineRange[]): string[] {
  return [...new Set(ranges.map((range) => range.file))];
}

export function testFileOf(module: string): string {
  if (!module.endsWith(".ts")) throw new Error(`${module}: a mutated module must be a .ts file`);

  return `${module.slice(0, -".ts".length)}.test.ts`;
}

function oneLine(code: string): string {
  return code.replaceAll(/\s+/gu, " ").trim();
}

/** One line per survivor: where it is, its mutator, and the code it replaced with what. */
export function describeSurvivor(file: string, source: string, mutant: Mutant): string {
  const { start, end } = mutant.location;
  const lines = source.split("\n");

  const original =
    start.line === end.line
      ? (lines[start.line - 1] ?? "").slice(start.column - 1, end.column - 1)
      : `${(lines[start.line - 1] ?? "").slice(start.column - 1)}…`;

  return `${file}:${start.line}:${start.column} ${mutant.status} ${mutant.mutatorName}: ${oneLine(original)} => ${oneLine(mutant.replacement)}`;
}

/** The undetected mutants whose lines meet one of the ranges, in source order. */
export function onChangedLines(results: readonly Mutant[], ranges: readonly LineRange[]): Mutant[] {
  return undetected(results).filter(({ location }) =>
    ranges.some((range) => location.start.line <= range.end && location.end.line >= range.start),
  );
}

export interface ModuleVerdict {
  readonly survivors: readonly string[];
  readonly summary: string;
}

/** A pass's verdict on one module: each survivor on its changed lines, then a count of the rest. */
export function moduleVerdict(
  module: string,
  source: string,
  results: readonly Mutant[],
  ranges: readonly LineRange[],
): ModuleVerdict {
  const tested = results.filter((result) => result.status !== "Ignored");
  const changed = onChangedLines(results, ranges);
  const elsewhere = undetected(results).length - changed.length;

  return {
    survivors: changed.map((mutant) => describeSurvivor(module, source, mutant)),
    summary: `mutation: ${module}: ${tested.length} mutant(s) tested, ${changed.length} undetected on the changed lines, ${elsewhere} elsewhere, outside this change`,
  };
}

/** The mutants no test detected, in source order. */
export function undetected(results: readonly Mutant[]): Mutant[] {
  return results
    .filter((result) => UNDETECTED.has(result.status))
    .toSorted(
      (a, b) =>
        a.fileName.localeCompare(b.fileName) ||
        a.location.start.line - b.location.start.line ||
        a.location.start.column - b.location.start.column,
    );
}

interface PushEvent {
  before?: string;
}

async function pushedFrom(eventPath: string | undefined): Promise<string> {
  if (eventPath === undefined) throw new Error("GITHUB_EVENT_PATH is unset on a push run");
  const event: PushEvent = await Bun.file(eventPath).json();

  if (event.before === undefined) throw new Error(`${eventPath} names no before`);

  return event.before;
}

async function baseRefOf(base: string | undefined, env: Env): Promise<string> {
  const resolved = baseOf(base, env);

  if (resolved.kind === "ref") return resolved.ref;

  return env.GITHUB_EVENT_NAME === "push" ? await pushedFrom(env.GITHUB_EVENT_PATH) : DEFAULT_BASE;
}

export async function changedLines(
  repoRoot: string,
  modules: readonly string[],
  base?: string,
  env: Env = process.env,
): Promise<LineRange[]> {
  const ref = await baseRefOf(base, env);
  const mergeBase = await mergeBaseWith(repoRoot, ref);

  if (mergeBase.kind === "none") throw new Error(mergeBase.reason);

  const diff =
    await $`git diff -U0 --no-color --no-ext-diff --no-renames --src-prefix=a/ --dst-prefix=b/ ${mergeBase.sha} -- ${modules}`
      .cwd(repoRoot)
      .quiet()
      .text();

  return changedRanges(diff);
}

/** The `$GITHUB_OUTPUT` line that tells CI whether to install Stryker and run it. */
export function githubOutput(ranges: readonly LineRange[]): string {
  return `mutate=${ranges.length > 0}\n`;
}

/**
 * What a pass adds to `stryker.config.ts`: one module, whole, and its own `.test.ts` alone, so a
 * flaky suite of another module never kills its mutants.
 */
export function runOptions(module: string) {
  return {
    mutate: [module],
    commandRunner: { command: `bun test ./${testFileOf(module)}` },
  };
}

async function mutate(repoRoot: string, module: string): Promise<MutantResult[]> {
  const { mode } = await stat(join(repoRoot, module));
  const { Stryker: Runner } = await import("@stryker-mutator/core");
  // Stryker reads the module and runs the command from the working directory.
  process.chdir(repoRoot);

  try {
    return await new Runner({ ...config, ...runOptions(module) }).runMutationTest();
  } finally {
    // In-place mode writes the original back without its mode, executable bit included.
    await chmod(join(repoRoot, module), mode);
  }
}

type Args = { readonly command: Command; readonly base: string | undefined };

export function parseArgs(args: readonly string[]): Args | null {
  const [given, flag, base, ...rest] = args;
  const command = COMMANDS.find((known) => known === given);

  if (command === undefined || rest.length > 0) return null;

  if (flag === undefined) return { command, base: undefined };

  return flag === "--base" && base !== undefined ? { command, base } : null;
}

if (import.meta.main) {
  const repoRoot = join(import.meta.dir, "..");
  const args = parseArgs(process.argv.slice(2));

  if (args === null) {
    console.error(`usage: bun ./scripts/mutation.ts <${COMMANDS.join("|")}> [--base <ref>]`);
    process.exit(2);
  }

  const ranges = await changedLines(repoRoot, config.mutate, args.base);

  if (args.command === "github-output") {
    const outputPath = process.env.GITHUB_OUTPUT;

    if (outputPath === undefined) throw new Error("GITHUB_OUTPUT is unset");
    await appendFile(outputPath, githubOutput(ranges));
  }

  if (ranges.length === 0) {
    console.error(`mutation: no changed line in ${config.mutate.join(", ")}`);
    process.exit(0);
  }

  console.error(`mutation: changed ${ranges.map((range) => rangeLabel(range)).join(", ")}`);

  if (args.command === "run") {
    let survived = 0;

    for (const module of modulesOf(ranges)) {
      const source = await Bun.file(join(repoRoot, module)).text();
      const results = await mutate(repoRoot, module);

      const verdict = moduleVerdict(
        module,
        source,
        results,
        ranges.filter((range) => range.file === module),
      );

      for (const line of [...verdict.survivors, verdict.summary]) console.error(line);
      survived += verdict.survivors.length;
    }

    process.exit(survived === 0 ? 0 : 1);
  }
}
