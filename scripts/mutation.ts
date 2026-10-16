#!/usr/bin/env bun

/**
 * Mutation testing on the lines a change alters, in the modules `stryker.config.ts` lists: Stryker
 * mutates those lines alone, the `.test.ts` beside each module must kill every mutant, and each
 * survivor is named with its file, line, mutator and replacement.
 *
 *   bun ./scripts/mutation.ts run             Stryker on the changed lines; a survivor exits 1
 *   bun ./scripts/mutation.ts github-output   `mutate=true` when a listed module has a changed line
 *
 * The change is the working tree against its merge-base with the base `affected.ts` resolves; on
 * an Actions push, the commit the push moved the branch from; on any other Actions run, `origin/dev`. Stryker is imported only once a changed line
 * asks for it, so CI installs it only then.
 */

import { appendFile, chmod, stat } from "node:fs/promises";
import { join, relative } from "node:path";

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

/** Stryker's `--mutate` spelling of a range: `file:start-end`. */
export function mutateSpec(range: LineRange): string {
  return `${range.file}:${range.start}-${range.end}`;
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

/** What a run adds to `stryker.config.ts`: the ranges, and one `bun test` over their modules' tests. */
export function runOptions(ranges: readonly LineRange[]) {
  const tests = [...new Set(ranges.map((range) => `./${testFileOf(range.file)}`))];

  return {
    mutate: ranges.map((range) => mutateSpec(range)),
    commandRunner: { command: `bun test ${tests.join(" ")}` },
  };
}

async function mutate(repoRoot: string, ranges: readonly LineRange[]): Promise<MutantResult[]> {
  const files = [...new Set(ranges.map((range) => range.file))];

  const modes = await Promise.all(
    files.map(async (file) => ({ file, mode: (await stat(join(repoRoot, file))).mode })),
  );

  const { Stryker: Runner } = await import("@stryker-mutator/core");
  // Stryker reads the modules and runs the command from the working directory.
  process.chdir(repoRoot);

  const runner = new Runner({ ...config, ...runOptions(ranges) });

  try {
    return await runner.runMutationTest();
  } finally {
    // In-place mode writes the originals back without their mode, executable bit included.
    await Promise.all(modes.map(({ file, mode }) => chmod(join(repoRoot, file), mode)));
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

  console.error(`mutation: ${ranges.map((range) => mutateSpec(range)).join(", ")}`);

  if (args.command === "run") {
    const results = await mutate(repoRoot, ranges);
    const survivors = undetected(results);

    for (const mutant of survivors) {
      const file = relative(repoRoot, mutant.fileName);
      console.error(describeSurvivor(file, await Bun.file(join(repoRoot, file)).text(), mutant));
    }

    console.error(
      `mutation: ${results.length} mutant(s) on the changed lines, ${survivors.length} undetected`,
    );
    process.exit(survivors.length === 0 ? 0 : 1);
  }
}
