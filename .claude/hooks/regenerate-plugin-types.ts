#!/usr/bin/env bun

/**
 * SessionStart hook — regenerates `vellum/types/claude-code.d.ts` when its
 * header names another Claude Code version than `claude --version`.
 *
 * Only a checkout on `dev` is rewritten: the regenerated file stays
 * uncommitted, and a dirty file stops `git pull` and `git rebase` in the
 * feature checkouts. There the hook reports the drift and writes nothing.
 *
 * `/plugin-types` also writes `-mcp` and `-plugins` files that describe the
 * developer's own session, so it writes into a temp directory and the hook
 * copies `claude-code.d.ts` back.
 */

import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { $ } from "bun";

import { HOOK_EXIT } from "./hook-io.ts";
import { checkoutRoot } from "./stop-gates.ts";

export const TYPES_PATH = "vellum/types/claude-code.d.ts";

export const REGENERATING_BRANCH = "dev";

const HEADER_PATTERN = /^\/\/ Written by Claude Code (\S+)\.$/u;

const VERSION_PATTERN = /^(\S+) \(Claude Code\)$/u;

// The headless run is a session of its own: its SessionStart would run this
// hook again.
const NO_HOOKS_SETTINGS = JSON.stringify({ disableAllHooks: true });

export function headerVersion(firstLine: string): string {
  const version = HEADER_PATTERN.exec(firstLine)?.[1];

  if (version === undefined) {
    throw new Error(
      `${TYPES_PATH}: expected "// Written by Claude Code <version>." on line 1, found: ${firstLine}`,
    );
  }

  return version;
}

export function installedVersion(versionOutput: string): string {
  const version = VERSION_PATTERN.exec(versionOutput.trim())?.[1];

  if (version === undefined) {
    throw new Error(`\`claude --version\` printed an unknown format: ${versionOutput.trim()}`);
  }

  return version;
}

async function regenerate(root: string): Promise<void> {
  const outDir = await mkdtemp(join(tmpdir(), "plugin-types-"));
  const generated = join(outDir, "claude-code.d.ts");

  try {
    // Print mode appends a piped stdin to the prompt, and only
    // CLAUDE_CODE_ENABLE_FUNCTION_HOOKS registers `/plugin-types`: without it
    // the prompt goes to the model, and the run still exits 0.
    const run =
      await $`claude -p --setting-sources project --settings ${NO_HOOKS_SETTINGS} --no-session-persistence ${`/plugin-types ${outDir}`} < /dev/null`
        .cwd(root)
        .env({ ...process.env, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: "1" })
        .nothrow()
        .quiet();

    if (run.exitCode !== 0 || !(await Bun.file(generated).exists())) {
      const output = `${run.stdout.toString()}${run.stderr.toString()}`.trim();
      throw new Error(
        `/plugin-types exited ${run.exitCode} without writing claude-code.d.ts: ${output}`,
      );
    }

    await copyFile(generated, join(root, TYPES_PATH));
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

/** The note for the user and the model, or null when the types match. */
async function checkTypes(rawInput: string): Promise<string | null> {
  // SAFETY: `cwd` is the one field read, and an absent one falls back to
  // the project.
  const { cwd } = JSON.parse(rawInput) as { cwd?: string };
  const root = await checkoutRoot(cwd, process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd());
  const typesFile = Bun.file(join(root, TYPES_PATH));

  if (!(await typesFile.exists())) return null;

  const firstLine = (await typesFile.slice(0, 256).text()).split(/\r?\n/u, 1)[0] ?? "";
  const written = headerVersion(firstLine);
  const installed = installedVersion(await $`claude --version`.text());

  if (written === installed) return null;

  const branch = (await $`git -C ${root} branch --show-current`.text()).trim();

  if (branch !== REGENERATING_BRANCH) {
    return `${TYPES_PATH}: written by Claude Code ${written}, installed ${installed}; a session in a checkout on ${REGENERATING_BRANCH} regenerates it.`;
  }

  await regenerate(root);

  return `${TYPES_PATH}: regenerated from Claude Code ${written} to ${installed}, left uncommitted.`;
}

if (import.meta.main) {
  try {
    const note = await checkTypes(await Bun.stdin.text());

    if (note !== null) {
      console.log(
        JSON.stringify({
          systemMessage: note,
          hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: note },
        }),
      );
    }
  } catch (error) {
    // Claude Code shows the first stderr line of a failed hook, and an
    // uncaught throw makes that line a Bun source frame.
    console.error(
      `regenerate-plugin-types: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(HOOK_EXIT.ERROR);
  }
}
