#!/usr/bin/env bun

/**
 * SessionStart hook — regenerates `vellum/types/claude-code.d.ts` and
 * `vellum/types/claude-code-tools.d.ts` when the first one's header names
 * another Claude Code version than `claude --version`.
 *
 * Only a checkout on `dev` is rewritten: the regenerated files stay
 * uncommitted, and a dirty file stops `git pull` and `git rebase` in the
 * feature checkouts. There the hook reports the drift and writes nothing.
 *
 * Claude Code writes a mod's types into its `.claude-plugin/types/` as it
 * loads it with `--plugin-dir`. The hook loads an empty mod from a temp
 * directory, logged out, and copies back the core and the tools; the MCP
 * file describes a session's own servers.
 */

import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { $ } from "bun";

import { checkoutRoot } from "./checkout.ts";
import { HOOK_EXIT } from "./hook-io.ts";

export const TYPES_PATH = "vellum/types/claude-code.d.ts";

export const TOOLS_TYPES_PATH = "vellum/types/claude-code-tools.d.ts";

export const REGENERATING_BRANCH = "dev";

const HEADER_PATTERN = /^\/\/ Written by Claude Code (\S+)\.$/u;

const VERSION_PATTERN = /^(\S+) \(Claude Code\)$/u;

const EMPTY_MOD = {
  ".claude-plugin/plugin.json": JSON.stringify({ name: "plugin-types", version: "0.0.0" }),
  "hooks/hooks.json": JSON.stringify({ modules: ["./register.js"] }),
  "hooks/register.js": "export function register() {}\n",
} as const;

const LOGIN_VARIABLES = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"];

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
  const scratch = await mkdtemp(join(tmpdir(), "plugin-types-"));
  const mod = join(scratch, "mod");
  const config = join(scratch, "config");
  const written = join(mod, ".claude-plugin", "types");
  const core = join(written, "claude-code", "index.d.ts");
  const tools = join(written, "claude-code-tools", "index.d.ts");

  try {
    for (const [path, content] of Object.entries(EMPTY_MOD)) {
      await mkdir(join(mod, path, ".."), { recursive: true });
      await writeFile(join(mod, path), content);
    }

    await mkdir(config);

    // Claude Code writes the types before it checks the login, so an empty
    // config stops the run there: no model call, and tool types that follow
    // the build rather than an account's features. The scratch directory
    // holds no settings, so the run's own SessionStart never reaches this hook.
    const env = Object.fromEntries(
      Object.entries({ ...process.env, CLAUDE_CONFIG_DIR: config }).filter(
        ([name]) => !LOGIN_VARIABLES.includes(name),
      ),
    );

    const run =
      await $`claude -p --setting-sources project --no-session-persistence --plugin-dir ${mod} ok < /dev/null`
        .cwd(scratch)
        .env(env)
        .nothrow()
        .quiet();

    if (!(await Bun.file(core).exists()) || !(await Bun.file(tools).exists())) {
      const output = `${run.stdout.toString()}${run.stderr.toString()}`.trim();
      throw new Error(
        `claude -p --plugin-dir exited ${run.exitCode} without writing the mod's types: ${output}`,
      );
    }

    await copyFile(core, join(root, TYPES_PATH));
    await copyFile(tools, join(root, TOOLS_TYPES_PATH));
  } finally {
    await rm(scratch, { recursive: true, force: true });
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
