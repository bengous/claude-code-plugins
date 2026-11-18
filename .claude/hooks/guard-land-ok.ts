#!/usr/bin/env bun

/**
 * PreToolUse hook for Bash: keeps `land-ok` the human's. `scripts/land.ts`
 * lands a `tier:human` pull request only once it carries `land-ok`, which the
 * human's own `/land <n>` puts on through `land-label.ts`. This hook denies an
 * agent's command that would put it on instead:
 *
 * - a command that names `land-ok` with a way to write a label;
 * - a command that runs `land-label.ts` itself, which labels from any payload;
 * - a command that hands `/land` to a Claude Code session, which takes it as
 *   the human's typing.
 *
 * It reads the command as text, with no shell parser: a command that spells
 * these words some other way goes through, and `land.ts` still reads when the
 * label went on.
 */

import { isRecord, recordField, stringField } from "../../agent-hooks/core/util/json.ts";
import { messageOf } from "../../tools/platform/pure.ts";
import { HOOK_EXIT } from "./hook-io.ts";

const ASK =
  "Ask the human to type /land <number> in their own session: only their own /land puts land-ok on.";

const LABEL = /\bland-ok\b/u;

const LABEL_WRITERS: readonly RegExp[] = [
  /--add-label\b/u,
  /\bgh\s+pr\s+edit\b/u,
  /\bgh\s+issue\s+edit\b/u,
  /\bgh\s+label\b/u,
  /\bgh\s+api\b/u,
  /\bcurl\b/u,
];

/** `land-label.ts` as a path, not `land-label.test.ts`. */
const HOOK_FILE = /(?:^|\/)land-label\.ts$/u;

/** The programs that run the script their first argument names; `run` and options before it are skipped. */
const INTERPRETERS = new Set(["bun", "node", "deno", "tsx", "bash", "sh", "exec", "env"]);

/** `/land` where a prompt holds it: at its start, after a space, an `=` or a quote, alone or before its argument. */
const TYPED_LAND = /(?:^|[\s="'])\/land(?:[\s"'\\]|$)/u;

/** A command word that hands a prompt to a session: Claude Code's CLI, or a terminal an agent sends keys to. */
const SESSION_PROGRAM = /(?:^|[\s;&|(])(?:\S*\/)?(?:claude|tmux|screen)(?=[\s;&|)]|$)/u;

const SESSION_SCRIPT = /\bfield-test\.ts\b/u;

/** The command's pieces between `;`, `&&`, `||`, `|` and newlines, each trimmed. */
function segmentsOf(command: string): string[] {
  return command
    .split(/;|&&|\|\||\||\n/u)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "");
}

/** The program a segment runs: its first word, or the script an interpreter there is handed. */
function programOf(segment: string): string {
  const words = segment.split(/[\s<>]+/u).map((word) => word.replaceAll(/["']/gu, ""));
  const [first = ""] = words;

  if (!INTERPRETERS.has(first.split("/").at(-1) ?? "")) return first;

  return words.slice(1).find((word) => word !== "run" && !word.startsWith("-")) ?? "";
}

function runsHook(command: string): boolean {
  return segmentsOf(command).some((segment) => HOOK_FILE.test(programOf(segment)));
}

/** Why the command is denied, or null when it passes. */
export function refusal(command: string): string | null {
  if (LABEL.test(command) && LABEL_WRITERS.some((writer) => writer.test(command))) {
    return `guard-land-ok: land-ok is the human's ok on a pull request, and this command writes labels and names it. ${ASK}`;
  }

  if (runsHook(command)) {
    return `guard-land-ok: land-label.ts is Claude Code's to run, on the /land the human typed: run by hand, it puts land-ok on from whatever payload it reads. ${ASK}`;
  }

  if (TYPED_LAND.test(command) && (SESSION_PROGRAM.test(command) || SESSION_SCRIPT.test(command))) {
    return `guard-land-ok: /land is the human's to type: this command hands it to a Claude Code session, which takes it as the human's own typing and puts land-ok on. ${ASK}`;
  }

  return null;
}

export function denial(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
}

if (import.meta.main) {
  try {
    const payload: unknown = JSON.parse(await Bun.stdin.text());
    const toolInput = isRecord(payload) ? recordField(payload, "tool_input") : undefined;
    const command = toolInput === undefined ? undefined : stringField(toolInput, "command");
    const reason = command === undefined ? null : refusal(command);

    if (reason !== null) console.log(denial(reason));
  } catch (error) {
    // Claude Code shows the first stderr line of a failed hook, and an
    // uncaught throw makes that line a Bun source frame.
    console.error(`guard-land-ok: ${messageOf(error)}`);
    process.exit(HOOK_EXIT.ERROR);
  }
}
