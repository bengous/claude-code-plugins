#!/usr/bin/env bun

/**
 * Run the gates of `EXPECTED_COMMANDS` as CI runs them, in parallel, from the
 * repo root, with the kits of the hooks modules the change reaches
 * (`affected.ts`); `--all` runs every kit. Silent when all pass; otherwise
 * prints a `Red gates: <names>` line, then each failing gate with its output,
 * and exits 1.
 *
 * That first line is the verdict `.claude/hooks/stop-gates.ts` compares from
 * one Stop to the next: changing its shape changes both files.
 */

import { join } from "node:path";

import { $ } from "bun";

import { currentScope, kitsOf, type Scope } from "./affected.ts";
import { EXPECTED_COMMANDS, hooksModuleGates } from "./check-lint-config.ts";
import { hooksModulePlugins } from "./lib/hooks-modules.ts";

export interface GateResult {
  gate: string;
  command: string;
  exitCode: number;
  output: string;
}

export function failureReport(results: GateResult[]): string {
  const red = results.filter((result) => result.exitCode !== 0);

  if (red.length === 0) return "";

  return [
    `Red gates: ${red.map((result) => result.gate).join(", ")}`,
    ...red.map((result) => `${result.gate}: ${result.command}\n${result.output}`),
  ].join("\n\n");
}

async function runGate(repoRoot: string, gate: string, command: string): Promise<GateResult> {
  const result = await $`sh -c ${command}`.cwd(repoRoot).nothrow().quiet();
  const output = `${result.stdout.toString()}${result.stderr.toString()}`.trim();

  return { gate, command, exitCode: result.exitCode, output };
}

if (import.meta.main) {
  const repoRoot = join(import.meta.dir, "..");
  const args = process.argv.slice(2);

  if (args.length > 1 || (args.length === 1 && args[0] !== "--all")) {
    console.error("usage: bun ./scripts/run-gates.ts [--all]");
    process.exit(2);
  }

  const install = await $`bun install --cwd vellum --frozen-lockfile --ignore-scripts`
    .cwd(repoRoot)
    .nothrow()
    .quiet();

  if (install.exitCode !== 0) {
    console.error(`vellum dependencies: ${install.stdout.toString()}${install.stderr.toString()}`);
    process.exit(1);
  }

  const scope: Scope =
    args[0] === "--all" ? { kind: "all", reason: "--all" } : await currentScope(repoRoot);

  const gates = [
    ...EXPECTED_COMMANDS,
    ...hooksModuleGates(kitsOf(scope, await hooksModulePlugins(repoRoot))),
  ];

  const results = await Promise.all(gates.map((pair) => runGate(repoRoot, pair.gate, pair.ci)));
  const report = failureReport(results);

  if (report !== "") {
    console.error(report);
    process.exit(1);
  }
}
