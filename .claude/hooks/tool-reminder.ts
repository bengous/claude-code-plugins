#!/usr/bin/env bun

/**
 * PostToolUse hook for Write: the first time a session creates a script that runs (a `.sh` file, or a `.ts`
 * file with an entry point), it hands the session a note to check what Claude Code, gh and this repository
 * already do. Once per session, decided by code alone: no model call, never blocks.
 *
 * A file created through Bash, an Edit, or a tool with no entry point the patterns know passes unseen.
 */

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, relative, sep } from "node:path";

import { isRecord, recordField, stringField } from "../../agent-hooks/core/util/json.ts";
import { createExclusiveSync } from "../../tools/platform/fs.ts";
import { isUnder, messageOf } from "../../tools/platform/pure.ts";
import { hookOutput } from "./format-on-edit.ts";
import { HOOK_EXIT } from "./hook-io.ts";

export interface CreatedFile {
  readonly path: string;
  readonly content: string;
}

export interface CreatedWrite extends CreatedFile {
  readonly sessionId: string;
}

const NOT_A_TOOL = /\.(?:test|spec|fixture|config|d)\.ts$/u;

const TS_ENTRY_POINT = /^#!|\bimport\.meta\.main\b|\bprocess\.argv\b|\bBun\.argv\b/u;

/** The file a Write created, from the hook's input; null for an overwrite or an input of another shape. */
export function createdWriteOf(json: string): CreatedWrite | null {
  const payload: unknown = JSON.parse(json);

  if (!isRecord(payload)) return null;

  const sessionId = stringField(payload, "session_id");
  const response = recordField(payload, "tool_response");
  const input = recordField(payload, "tool_input");

  if (sessionId === undefined || response === undefined || input === undefined) return null;

  if (stringField(response, "type") !== "create") return null;

  const path = stringField(input, "file_path");
  const content = stringField(input, "content");

  return path === undefined || content === undefined ? null : { sessionId, path, content };
}

/** Whether `file`, inside `projectDir`, is a script someone runs. */
export function isTool(file: CreatedFile, projectDir: string): boolean {
  if (!isUnder(projectDir, file.path, sep)) return false;

  const extension = extname(file.path);

  if (extension === ".sh") return true;

  return extension === ".ts" && !NOT_A_TOOL.test(file.path) && TS_ENTRY_POINT.test(file.content);
}

export function reminder(path: string): string {
  return `You just created ${path}, a script that runs. Before you build further, check whether Claude Code (the skills and slash commands listed in your context, \`claude --help\`), gh, or a script of this repository already does what it does, and say in one line what you found. This note comes once per session.`;
}

/** Claims the session's one reminder: true the first time for `sessionId`, false after. */
export function claimSession(stateDir: string, sessionId: string): boolean {
  mkdirSync(stateDir, { recursive: true });

  return createExclusiveSync(join(stateDir, sessionId), "");
}

/** The hook's stdout for one Write: the note the first time a session creates a tool, null otherwise. */
export function noteFor(json: string, projectDir: string, stateDir: string): string | null {
  const file = createdWriteOf(json);

  if (file === null || !isTool(file, projectDir) || !claimSession(stateDir, file.sessionId)) {
    return null;
  }

  return hookOutput(reminder(relative(projectDir, file.path)));
}

const STATE_DIR = join(tmpdir(), "claude-tool-reminder");

if (import.meta.main) {
  try {
    const projectDir = process.env["CLAUDE_PROJECT_DIR"];

    const note =
      projectDir === undefined ? null : noteFor(await Bun.stdin.text(), projectDir, STATE_DIR);

    if (note !== null) console.log(note);
  } catch (error) {
    // Claude Code shows the first stderr line of a failed hook, and an
    // uncaught throw makes that line a Bun source frame.
    console.error(`tool-reminder: ${messageOf(error)}`);
    process.exit(HOOK_EXIT.ERROR);
  }
}
