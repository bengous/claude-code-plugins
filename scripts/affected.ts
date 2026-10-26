#!/usr/bin/env bun

/**
 * What a change reaches: the one map from a changed path to the suites and the
 * hooks-module kits that run for it, read by pre-push, by `run-gates.ts` at
 * Stop, and by CI. The paths are the working tree's against its merge-base
 * with the base, committed or not, untracked included. A top-level directory
 * is a unit; a path no unit owns runs everything.
 *
 *   bun ./scripts/affected.ts test            the scope's suites, `scripts/` always among them
 *   bun ./scripts/affected.ts github-output   `all`, `units` and `kits`, appended to `$GITHUB_OUTPUT`
 *   bun ./scripts/affected.ts print           the scope, as JSON
 *
 * `test --retry <job>`, in CI alone, runs each suite through `flaky-report.ts`'s retry: the files
 * whose tests failed run once more, and each test that passed then is reported for `<job>`.
 *
 * The base is `--base <ref>`, else, in a pull request's run, the first parent
 * of the merge commit it checks out, else `origin/dev`. Any other Actions
 * event runs everything.
 */

import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { $ } from "bun";

import { retryBunReported } from "./flaky-report.ts";
import { hooksModulePlugins } from "./lib/hooks-modules.ts";

/** A top-level directory, or `.claude/hooks`. */
export type Unit = string;

export type PathClass =
  | { readonly kind: "all" }
  | { readonly kind: "gates" }
  | { readonly kind: "none" }
  | { readonly kind: "unit"; readonly unit: Unit };

export type Scope =
  | { readonly kind: "all"; readonly reason: string }
  | { readonly kind: "units"; readonly units: readonly Unit[] };

export type Env = Readonly<Record<string, string | undefined>>;

export type Base =
  | { readonly kind: "ref"; readonly ref: string }
  | { readonly kind: "push"; readonly before: string }
  | { readonly kind: "all"; readonly reason: string };

export type MergeBase =
  | { readonly kind: "found"; readonly sha: string }
  | { readonly kind: "none"; readonly reason: string };

const HOOKS_UNIT: Unit = ".claude/hooks";

export const DEFAULT_BASE = "origin/dev";

/**
 * A pull request's run checks out the merge of its head into the base's tip, its first parent. The
 * event's `pull_request.base.sha` can be older, and would count the commits landed since as its own.
 */
const PULL_REQUEST_BASE = "HEAD^1";

const GATES_ONLY = ["docs/", ".claude-plugin/", ".claude/rules/"];

const EVERYTHING = ["scripts/", "tools/", ".github/", ".lefthook/", ".claude/"];

const COMMANDS = ["test", "github-output", "print"] as const;

type Command = (typeof COMMANDS)[number];

export function classify(path: string): PathClass {
  const slash = path.indexOf("/");

  if (path.startsWith("archive/")) return { kind: "none" };

  if (path.startsWith(`${HOOKS_UNIT}/`)) return { kind: "unit", unit: HOOKS_UNIT };

  if (GATES_ONLY.some((prefix) => path.startsWith(prefix))) return { kind: "gates" };

  if (slash === -1 && path.endsWith(".md")) return { kind: "gates" };

  if (slash === -1 || EVERYTHING.some((prefix) => path.startsWith(prefix))) return { kind: "all" };

  return { kind: "unit", unit: path.slice(0, slash) };
}

export function scopeOf(paths: readonly string[]): Scope {
  const units = new Set<Unit>();

  for (const path of paths) {
    const pathClass = classify(path);

    if (pathClass.kind === "all") return { kind: "all", reason: `${path} reaches every suite` };

    if (pathClass.kind === "unit") units.add(pathClass.unit);
  }

  return { kind: "units", units: [...units].toSorted() };
}

interface PushEvent {
  before?: string;
}

/** The ref a change is measured from; a push run's is the commit the push moved the branch from. */
export async function baseOf(explicit: string | undefined, env: Env): Promise<Base> {
  if (explicit !== undefined) return { kind: "ref", ref: explicit };

  if (env.GITHUB_EVENT_NAME === "pull_request") return { kind: "ref", ref: PULL_REQUEST_BASE };

  if (env.GITHUB_EVENT_NAME === "push") {
    const eventPath = env.GITHUB_EVENT_PATH;

    if (eventPath === undefined) throw new Error("GITHUB_EVENT_PATH is unset on a push run");
    const event: PushEvent = await Bun.file(eventPath).json();

    if (event.before === undefined) throw new Error(`${eventPath} names no before`);

    return { kind: "push", before: event.before };
  }

  if (env.GITHUB_ACTIONS === "true") {
    return {
      kind: "all",
      reason: `a ${env.GITHUB_EVENT_NAME ?? "workflow"} run checks everything`,
    };
  }

  return { kind: "ref", ref: DEFAULT_BASE };
}

/** HEAD's merge-base with `ref`, the commit a change is measured from. */
export async function mergeBaseWith(repoRoot: string, ref: string): Promise<MergeBase> {
  const found = await $`git merge-base HEAD ${ref}`.cwd(repoRoot).nothrow().quiet();

  if (found.exitCode === 0) return { kind: "found", sha: found.stdout.toString().trim() };
  const why = found.stderr.toString().trim();

  return { kind: "none", reason: `no merge-base with ${ref}${why === "" ? "" : `: ${why}`}` };
}

function nulSeparated(text: string): string[] {
  return text.split("\0").filter((path) => path !== "");
}

export async function currentScope(
  repoRoot: string,
  base?: string,
  env: Env = process.env,
): Promise<Scope> {
  const resolved = await baseOf(base, env);

  if (resolved.kind === "all") return resolved;

  if (resolved.kind === "push") return { kind: "all", reason: "a push run checks everything" };
  const mergeBase = await mergeBaseWith(repoRoot, resolved.ref);

  if (mergeBase.kind === "none") return { kind: "all", reason: mergeBase.reason };
  const since = mergeBase.sha;

  const changed = await $`git diff --name-only --no-renames -z ${since}`
    .cwd(repoRoot)
    .quiet()
    .text();

  const untracked = await $`git ls-files --others --exclude-standard -z`
    .cwd(repoRoot)
    .quiet()
    .text();

  return scopeOf([...nulSeparated(changed), ...nulSeparated(untracked)]);
}

/** The hooks-module plugins whose kits the scope runs, in catalog order. */
export function kitsOf(scope: Scope, modulePlugins: readonly string[]): readonly string[] {
  return scope.kind === "all"
    ? modulePlugins
    : modulePlugins.filter((plugin) => scope.units.includes(plugin));
}

/** The `bun` argument lists of the scope's suites; `bun test` alone skips dot directories. */
export function testRuns(scope: Scope): readonly (readonly string[])[] {
  if (scope.kind === "all") {
    return [
      ["test", "--parallel"],
      ["test", "--parallel", `./${HOOKS_UNIT}/`],
    ];
  }

  return [["test", "--parallel", "./scripts/", ...scope.units.map((unit) => `./${unit}/`)]];
}

export function githubOutput(scope: Scope, kits: readonly string[]): string {
  const units = scope.kind === "all" ? [] : scope.units;

  return `all=${scope.kind === "all"}\nunits=${JSON.stringify(units)}\nkits=${JSON.stringify(kits)}\n`;
}

export type Args = {
  readonly command: Command;
  readonly base: string | undefined;
  readonly retryJob: string | undefined;
};

/** `node:util`'s `parseArgs` over the CLI's two options; an unknown flag or a missing value is null. */
function parsedOrNull(args: readonly string[]) {
  try {
    return parseArgs({
      args: [...args],
      options: { base: { type: "string" }, retry: { type: "string" } },
      allowPositionals: true,
    });
  } catch {
    return null;
  }
}

export function readArgs(args: readonly string[]): Args | null {
  const parsed = parsedOrNull(args);

  if (parsed === null) return null;

  const { values, positionals } = parsed;
  const command = COMMANDS.find((known) => known === positionals[0]);

  if (command === undefined || positionals.length > 1) return null;

  if (values.retry !== undefined && command !== "test") return null;

  return { command, base: values.base, retryJob: values.retry };
}

async function runTests(
  repoRoot: string,
  scope: Scope,
  retryJob: string | undefined,
): Promise<number> {
  for (const [at, args] of testRuns(scope).entries()) {
    console.error(`affected: bun ${args.join(" ")}`);

    const argv = [process.execPath, ...args];

    const code =
      retryJob === undefined
        ? await Bun.spawn(argv, { cwd: repoRoot, stdio: ["inherit", "inherit", "inherit"] }).exited
        : await retryBunReported(argv, retryJob, `${retryJob}-${at + 1}`);

    if (code !== 0) return code;
  }

  return 0;
}

if (import.meta.main) {
  const repoRoot = join(import.meta.dir, "..");
  const args = readArgs(process.argv.slice(2));

  if (args === null) {
    console.error(
      `usage: bun ./scripts/affected.ts <${COMMANDS.join("|")}> [--base <ref>] [--retry <job>, test only]`,
    );
    process.exit(2);
  }

  const scope = await currentScope(repoRoot, args.base);

  if (scope.kind === "all") console.error(`affected: everything runs: ${scope.reason}`);

  switch (args.command) {
    case "test":
      process.exit(await runTests(repoRoot, scope, args.retryJob));
      break;
    case "github-output": {
      const outputPath = process.env.GITHUB_OUTPUT;

      if (outputPath === undefined) throw new Error("GITHUB_OUTPUT is unset");
      const kits = kitsOf(scope, await hooksModulePlugins(repoRoot));
      await appendFile(outputPath, githubOutput(scope, kits));
      break;
    }

    case "print":
      console.log(JSON.stringify(scope));
      break;
  }
}
