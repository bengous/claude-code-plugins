#!/usr/bin/env bun

/**
 * Lint every tracked shell script with shellcheck and shfmt.
 *
 * With no argument it walks the whole repo; with paths it checks only those,
 * after applying the same exclusions (used by the lefthook pre-commit job).
 */

import { $ } from "bun";

const SHFMT_FLAGS = ["-i", "2", "-ci"] as const;

const EXCLUDED_PREFIXES = ["archive/"] as const;

const SHEBANG_RE = /^#!.*\b(?:ba|z|k|da)?sh\b/u;

function isExcluded(path: string): boolean {
  return EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/** A tracked file is a shell script if it ends in .sh or opens with a shell shebang. */
async function isShellScript(path: string): Promise<boolean> {
  if (path.endsWith(".sh")) return true;
  const file = Bun.file(path);
  if (!(await file.exists())) return false;
  const head = await file.slice(0, 128).text();
  return SHEBANG_RE.test(head.split("\n", 1)[0] ?? "");
}

async function shellTargets(candidates: string[]): Promise<string[]> {
  const kept: string[] = [];
  for (const path of candidates) {
    if (isExcluded(path)) continue;
    if (await isShellScript(path)) kept.push(path);
  }
  return kept.toSorted();
}

async function trackedFiles(): Promise<string[]> {
  const listed = await $`git ls-files -z`.quiet().text();
  return listed.split("\0").filter(Boolean);
}

async function run(tool: string, args: string[]): Promise<boolean> {
  const proc = Bun.spawn([tool, ...args], { stdout: "inherit", stderr: "inherit" });
  return (await proc.exited) === 0;
}

const requested = process.argv.slice(2);
const targets = await shellTargets(requested.length > 0 ? requested : await trackedFiles());

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
