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
 * The base is `--base <ref>`, else a pull request's base in GitHub Actions,
 * else `origin/dev`. Any other Actions event runs everything.
 */

import { appendFile } from "node:fs/promises";
import { join } from "node:path";

import { $ } from "bun";

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

type Base =
  | { readonly kind: "ref"; readonly ref: string }
  | { readonly kind: "all"; readonly reason: string };

const HOOKS_UNIT: Unit = ".claude/hooks";

const DEFAULT_BASE = "origin/dev";

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

interface PullRequestEvent {
  pull_request?: { base?: { sha?: string } };
}

async function pullRequestBase(eventPath: string | undefined): Promise<string> {
  if (eventPath === undefined) throw new Error("GITHUB_EVENT_PATH is unset on a pull_request run");
  const event: PullRequestEvent = await Bun.file(eventPath).json();
  const sha = event.pull_request?.base?.sha;

  if (sha === undefined) throw new Error(`${eventPath} names no pull_request.base.sha`);

  return sha;
}

async function baseOf(explicit: string | undefined, env: Env): Promise<Base> {
  if (explicit !== undefined) return { kind: "ref", ref: explicit };

  if (env.GITHUB_EVENT_NAME === "pull_request") {
    return { kind: "ref", ref: await pullRequestBase(env.GITHUB_EVENT_PATH) };
  }

  if (env.GITHUB_ACTIONS === "true") {
    return {
      kind: "all",
      reason: `a ${env.GITHUB_EVENT_NAME ?? "workflow"} run checks everything`,
    };
  }

  return { kind: "ref", ref: DEFAULT_BASE };
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
  const mergeBase = await $`git merge-base HEAD ${resolved.ref}`.cwd(repoRoot).nothrow().quiet();

  if (mergeBase.exitCode !== 0) {
    const why = mergeBase.stderr.toString().trim();

    return {
      kind: "all",
      reason: `no merge-base with ${resolved.ref}${why === "" ? "" : `: ${why}`}`,
    };
  }

  const since = mergeBase.stdout.toString().trim();

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

type Args = { readonly command: Command; readonly base: string | undefined };

function parseArgs(args: readonly string[]): Args | null {
  const [given, flag, base, ...rest] = args;
  const command = COMMANDS.find((known) => known === given);

  if (command === undefined || rest.length > 0) return null;

  if (flag === undefined) return { command, base: undefined };

  return flag === "--base" && base !== undefined ? { command, base } : null;
}

async function runTests(repoRoot: string, scope: Scope): Promise<number> {
  for (const args of testRuns(scope)) {
    console.error(`affected: bun ${args.join(" ")}`);

    const code = await Bun.spawn([process.execPath, ...args], {
      cwd: repoRoot,
      stdio: ["inherit", "inherit", "inherit"],
    }).exited;

    if (code !== 0) return code;
  }

  return 0;
}

if (import.meta.main) {
  const repoRoot = join(import.meta.dir, "..");
  const args = parseArgs(process.argv.slice(2));

  if (args === null) {
    console.error(`usage: bun ./scripts/affected.ts <${COMMANDS.join("|")}> [--base <ref>]`);
    process.exit(2);
  }

  const scope = await currentScope(repoRoot, args.base);

  if (scope.kind === "all") console.error(`affected: everything runs: ${scope.reason}`);

  switch (args.command) {
    case "test":
      process.exit(await runTests(repoRoot, scope));
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
