#!/usr/bin/env bun

/**
 * Lint every shell script of the working tree with shellcheck and shfmt.
 *
 * With no argument it walks the whole repo, untracked files included; with
 * paths it checks only those, after applying the same exclusions.
 */

import { isShellScript } from "./lib/shell-scripts.ts";
import { workingTreeFiles } from "./lib/working-tree-files.ts";

const SHFMT_FLAGS = ["-i", "2", "-ci"] as const;

const EXCLUDED_PREFIXES = ["archive/"] as const;

function isExcluded(path: string): boolean {
  return EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

async function shellTargets(candidates: string[]): Promise<string[]> {
  const kept: string[] = [];

  for (const path of candidates) {
    if (isExcluded(path)) continue;

    if (await isShellScript(path)) kept.push(path);
  }

  return kept.toSorted();
}

async function run(tool: string, args: string[]): Promise<boolean> {
  const proc = Bun.spawn([tool, ...args], { stdout: "inherit", stderr: "inherit" });

  return (await proc.exited) === 0;
}

const requested = process.argv.slice(2);

const targets = await shellTargets(requested.length > 0 ? requested : await workingTreeFiles());

if (targets.length === 0) {
  process.exit(0);
}

const shellcheckOk = await run("shellcheck", ["--format=gcc", ...targets]);

const shfmtOk = await run("shfmt", [...SHFMT_FLAGS, "-d", ...targets]);

if (!shellcheckOk || !shfmtOk) {
  if (!shfmtOk) {
    console.error(`\nRun: shfmt ${SHFMT_FLAGS.join(" ")} -w <file>`);
  }

  process.exit(1);
}
