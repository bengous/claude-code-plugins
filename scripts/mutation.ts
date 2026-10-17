#!/usr/bin/env bun

/**
 * Mutation testing on what a change alters in the modules `stryker.config.ts` lists, or in the
 * `.test.ts` beside each: Stryker mutates each such module whole, in a pass of its own against
 * that `.test.ts` alone. A survivor whose lines meet a changed line of the module fails. When the
 * `.test.ts` changed, a second pass runs the module and its tests as they were at the base, and a
 * mutant they killed that survives now fails too: the tests were weakened. Each failure is named
 * with its file, line, mutator and replacement. A whole module, since Stryker keeps a mutant only
 * when its whole node lies inside a line range: a block or a condition that spans past a changed
 * line would go untested.
 *
 *   bun ./scripts/mutation.ts run             Stryker on each module the change reaches; a failure exits 1
 *   bun ./scripts/mutation.ts github-output   `mutate=true` when the change reaches a listed module
 *
 * The change is the working tree against its merge-base with the base `affected.ts` resolves, or
 * `origin/dev` on an Actions run that resolves none. Stryker is imported only once the change
 * reaches a listed module, so CI installs it only then.
 */

import { appendFile, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Stryker } from "@stryker-mutator/core";
import { $ } from "bun";

import config from "../stryker.config.ts";
import { type Base, baseOf, DEFAULT_BASE, type Env, mergeBaseWith } from "./affected.ts";

export interface LineRange {
  readonly file: string;
  readonly start: number;
  readonly end: number;
}

/** A hunk of `git diff -U0`: `@@ -oldStart,oldCount +newStart,newCount @@` in `file`. */
export interface Hunk {
  readonly file: string;
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
}

export interface Change {
  readonly since: string;
  readonly hunks: readonly Hunk[];
}

type MutantResult = Awaited<ReturnType<Stryker["runMutationTest"]>>[number];

export type Mutant = Pick<
  MutantResult,
  "fileName" | "location" | "mutatorName" | "replacement" | "status"
>;

const COMMANDS = ["run", "github-output"] as const;

type Command = (typeof COMMANDS)[number];

const UNDETECTED = new Set(["Survived", "NoCoverage"]);

const DETECTED = new Set(["Killed", "Timeout"]);

/**
 * The hunks of a `git diff -U0` whose new side is prefixed `b/`. A file's header runs from its
 * `diff --git` line to its first hunk: past it, `+++ b/…` is an added line. A deleted file's new
 * side is `/dev/null`: its hunks are dropped.
 */
export function hunksOf(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let file: string | null = null;
  let inHeader = false;

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHeader = true;
      file = null;
    }

    if (inHeader && line.startsWith("+++ b/")) file = line.slice("+++ b/".length);
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);

    if (header === null) continue;
    inHeader = false;

    if (file === null) continue;

    hunks.push({
      file,
      oldStart: Number(header[1]),
      oldCount: header[2] === undefined ? 1 : Number(header[2]),
      newStart: Number(header[3]),
      newCount: header[4] === undefined ? 1 : Number(header[4]),
    });
  }

  return hunks;
}

/** The lines a hunk changes: those it adds or rewrites, or for a deletion the two around its cut. */
export function rangeOf(hunk: Hunk): LineRange {
  return hunk.newCount === 0
    ? { file: hunk.file, start: Math.max(hunk.newStart, 1), end: hunk.newStart + 1 }
    : { file: hunk.file, start: hunk.newStart, end: hunk.newStart + hunk.newCount - 1 };
}

export function changedRanges(diff: string): LineRange[] {
  return hunksOf(diff).map((hunk) => rangeOf(hunk));
}

/** Where a line the change left alone sat at the base; `null` for a line the change wrote. */
export function baseLineOf(line: number, hunks: readonly Hunk[]): number | null {
  let shift = 0;

  for (const hunk of hunks) {
    const lastNew = hunk.newStart + hunk.newCount - 1;

    if (hunk.newCount > 0 && line >= hunk.newStart && line <= lastNew) return null;

    if ((hunk.newCount > 0 ? lastNew : hunk.newStart) < line)
      shift += hunk.newCount - hunk.oldCount;
  }

  return line - shift;
}

export function rangeLabel(range: LineRange): string {
  return `${range.file}:${range.start}-${range.end}`;
}

/** The listed modules the hunks reach, through their own lines or their `.test.ts`, each once. */
export function modulesOf(hunks: readonly Hunk[], listed: readonly string[]): string[] {
  const reached = hunks.flatMap(
    (hunk) =>
      listed.find((module) => module === hunk.file || testFileOf(module) === hunk.file) ?? [],
  );

  return [...new Set(reached)];
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

function meets(mutant: Mutant, ranges: readonly LineRange[]): boolean {
  const { start, end } = mutant.location;

  return ranges.some((range) => start.line <= range.end && end.line >= range.start);
}

/** A mutant's identity at the base: its mutator, its replacement, and where it sat there. */
function baseKeyOf(mutant: Mutant, hunks: readonly Hunk[]): string | null {
  const { start, end } = mutant.location;
  const startLine = baseLineOf(start.line, hunks);
  const endLine = baseLineOf(end.line, hunks);

  if (startLine === null || endLine === null) return null;

  return `${mutant.mutatorName}|${mutant.replacement}|${startLine}:${start.column}-${endLine}:${end.column}`;
}

export interface ModuleVerdict {
  readonly failures: readonly string[];
  readonly summary: string;
}

export interface ModulePasses {
  readonly module: string;
  /** The module's source at the head, where `head`'s locations point. */
  readonly source: string;
  readonly head: readonly Mutant[];
  /** The pass over the module and its tests at the base, run when the tests changed. */
  readonly base: readonly Mutant[] | null;
  /** The module's own hunks. */
  readonly hunks: readonly Hunk[];
}

/**
 * One module's verdict: each undetected mutant on a changed line, then each one the base's tests
 * killed, matched by the line it sat on there; the summary counts the others apart.
 */
export function moduleVerdict(passes: ModulePasses): ModuleVerdict {
  const { module, source, head, base, hunks } = passes;
  const tested = head.filter((result) => result.status !== "Ignored");
  const missed = undetected(head);
  const ranges = hunks.map((hunk) => rangeOf(hunk));
  const onChanged = missed.filter((mutant) => meets(mutant, ranges));

  const killedAtBase = new Set(
    (base ?? [])
      .filter((mutant) => DETECTED.has(mutant.status))
      .map((mutant) => baseKeyOf(mutant, [])),
  );

  const weakened = missed.filter(
    (mutant) => !onChanged.includes(mutant) && killedAtBase.has(baseKeyOf(mutant, hunks)),
  );

  const elsewhere = missed.length - onChanged.length - weakened.length;

  const weakenedClause =
    base === null ? "" : `, ${weakened.length} killed at the base and undetected now`;

  return {
    failures: [
      ...onChanged.map((mutant) => describeSurvivor(module, source, mutant)),
      ...weakened.map(
        (mutant) => `${describeSurvivor(module, source, mutant)} (killed at the base)`,
      ),
    ],
    summary: `mutation: ${module}: ${tested.length} mutant(s) tested, ${onChanged.length} undetected on the changed lines${weakenedClause}, ${elsewhere} elsewhere, outside this change`,
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

/** A base as a ref; an Actions run that measures from nowhere in particular measures from `origin/dev`. */
function refOf(base: Base): string {
  switch (base.kind) {
    case "ref":
      return base.ref;
    case "push":
      return base.before;
    case "all":
      return DEFAULT_BASE;
  }
}

/** The hunks of the listed modules and their `.test.ts` since the merge-base with the base. */
export async function changeSince(
  repoRoot: string,
  modules: readonly string[],
  base?: string,
  env: Env = process.env,
): Promise<Change> {
  const ref = refOf(await baseOf(base, env));
  const mergeBase = await mergeBaseWith(repoRoot, ref);

  if (mergeBase.kind === "none") throw new Error(mergeBase.reason);
  const paths = modules.flatMap((module) => [module, testFileOf(module)]);

  const diff =
    await $`git diff -U0 --no-color --no-ext-diff --no-renames --src-prefix=a/ --dst-prefix=b/ ${mergeBase.sha} -- ${paths}`
      .cwd(repoRoot)
      .quiet()
      .text();

  return { since: mergeBase.sha, hunks: hunksOf(diff) };
}

/** The tree at `sha`, written to a directory of its own, which the caller removes. */
export async function snapshotAt(repoRoot: string, sha: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mutation-base-"));
  await $`git archive --format=tar ${sha} | tar -x -C ${dir}`.cwd(repoRoot).quiet();

  return dir;
}

/** The `$GITHUB_OUTPUT` line that tells CI whether to install Stryker and run it. */
export function githubOutput(hunks: readonly Hunk[]): string {
  return `mutate=${hunks.length > 0}\n`;
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

export async function mutate(repoRoot: string, module: string): Promise<MutantResult[]> {
  const { Stryker: Runner } = await import("@stryker-mutator/core");
  // Stryker copies the working directory into its sandbox, and mutates the copy.
  process.chdir(repoRoot);

  return new Runner({ ...config, ...runOptions(module) }).runMutationTest();
}

async function existsAt(repoRoot: string, sha: string, path: string): Promise<boolean> {
  return (await $`git cat-file -e ${sha}:${path}`.cwd(repoRoot).nothrow().quiet()).exitCode === 0;
}

/** The pass over the module and its tests as they were at `sha`; `null` when either was missing. */
async function mutateAt(
  repoRoot: string,
  sha: string,
  module: string,
): Promise<MutantResult[] | null> {
  const present = await Promise.all(
    [module, testFileOf(module)].map((path) => existsAt(repoRoot, sha, path)),
  );

  if (present.includes(false)) return null;
  const dir = await snapshotAt(repoRoot, sha);

  try {
    await symlink(join(repoRoot, "node_modules"), join(dir, "node_modules"), "dir");

    return await mutate(dir, module);
  } finally {
    process.chdir(repoRoot);
    await rm(dir, { recursive: true, force: true });
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

  const change = await changeSince(repoRoot, config.mutate, args.base);

  if (args.command === "github-output") {
    const outputPath = process.env.GITHUB_OUTPUT;

    if (outputPath === undefined) throw new Error("GITHUB_OUTPUT is unset");
    await appendFile(outputPath, githubOutput(change.hunks));
  }

  if (change.hunks.length === 0) {
    console.error(`mutation: no change in ${config.mutate.join(", ")} or their tests`);
    process.exit(0);
  }

  console.error(
    `mutation: changed ${change.hunks.map((hunk) => rangeLabel(rangeOf(hunk))).join(", ")}`,
  );

  if (args.command === "run") {
    let failed = 0;

    for (const module of modulesOf(change.hunks, config.mutate)) {
      const testsChanged = change.hunks.some((hunk) => hunk.file === testFileOf(module));
      const source = await Bun.file(join(repoRoot, module)).text();
      const head = await mutate(repoRoot, module);
      const base = testsChanged ? await mutateAt(repoRoot, change.since, module) : null;

      if (testsChanged && base === null) {
        console.error(
          `mutation: ${module}: no base pass, it or its tests did not exist at ${change.since}`,
        );
      }

      const verdict = moduleVerdict({
        module,
        source,
        head,
        base,
        hunks: change.hunks.filter((hunk) => hunk.file === module),
      });

      for (const line of [...verdict.failures, verdict.summary]) console.error(line);
      failed += verdict.failures.length;
    }

    process.exit(failed === 0 ? 0 : 1);
  }
}
