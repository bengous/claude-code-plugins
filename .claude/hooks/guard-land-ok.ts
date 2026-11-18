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

/** GitHub matches a label's name whatever its case. */
const LABEL = /\bland-ok\b/iu;

const GH_LABEL_WRITERS: readonly RegExp[] = [
  /--(?:add|remove)-label\b/u,
  /\bgh\s+(?:pr|issue)\s+edit\b/u,
  /\bgh\s+label\b/u,
];

const GH_API = /\bgh\s+api\b/u;

const GH_API_WRITES =
  /(?:^|\s)(?:(?:-X|--method)[\s=]*(?:POST|PUT|PATCH|DELETE)\b|(?:-f|-F|--field|--raw-field|--input)(?=[\s=]|$))/iu;

const CURL = /\bcurl\b/u;

/** A GraphQL call carries its query in a field: it writes only when the query is a mutation. */
const GH_GRAPHQL = /\bgh\s+api\s+(?:\S+\s+)*?graphql\b/u;

const MUTATION = /\bmutation\b/u;

/** `-d` and `-F` take their value glued to them, and either makes the request a POST. */
const CURL_WRITES =
  /(?:^|\s)(?:(?:-X|--request)[\s=]*(?:POST|PUT|PATCH|DELETE)\b|-[dF]|(?:--data[\w-]*|--form[\w-]*|--json)(?=[\s=]|$))/u;

/** A label option whose value Bash expands: the label is not written in the statement. */
const EXPANDED_LABEL = /--(?:add|remove)-label[\s=]*["']?[^\s"']*[$`]/u;

const GH_LABEL = /\bgh\s+label\b/u;

const EXPANDS = /[$`]/u;

/** A request's body can also come from a heredoc. */
const EXPANDS_OR_READS_A_HEREDOC = /[$`]|<</u;

/** `land-label.ts` as a path, not `land-label.test.ts`. */
const HOOK_FILE = /(?:^|\/)land-label\.ts$/u;

/** The programs that run the script their first argument names; `run` and options before it are skipped. */
const INTERPRETERS = new Set(["bun", "node", "deno", "tsx", "bash", "sh"]);

/** The words that run the command after them: skipped, with their options and a `timeout`'s duration. */
const WRAPPERS = new Set(["env", "timeout", "nice", "time", "command", "exec", "nohup"]);

const ASSIGNMENT = /^[A-Za-z_]\w*=/u;

const DURATION = /^\d+(?:\.\d+)?[smhd]?$/u;

/** `/land` where a prompt holds it: at its start, after a space, an `=` or a quote, alone or before its argument. */
const TYPED_LAND = /(?:^|[\s="'])\/land(?:[\s"'\\]|$)/u;

/** A command word that hands a prompt to a session: Claude Code's CLI, or a terminal an agent sends keys to. */
const SESSION_PROGRAM = /(?:^|[\s;&|(])(?:\S*\/)?(?:claude(?:-code)?|tmux|screen)(?=[\s;&|)]|$)/u;

const SESSION_SCRIPT = /\bfield-test\.ts\b/u;

function pieces(command: string, breaks: RegExp): string[] {
  return command
    .split(breaks)
    .map((piece) => piece.trim())
    .filter((piece) => piece !== "");
}

/** The words a piece runs, from its program on: assignments and wrappers before it are dropped. */
function programWords(piece: string): string[] {
  const words = piece.split(/[\s<>]+/u).map((word) => word.replaceAll(/["']/gu, ""));

  const start = words.findIndex(
    (word) =>
      !ASSIGNMENT.test(word) &&
      !WRAPPERS.has(nameOf(word)) &&
      !DURATION.test(word) &&
      !word.startsWith("-"),
  );

  return start === -1 ? [] : words.slice(start);
}

function nameOf(word: string): string {
  return word.split("/").at(-1) ?? "";
}

/**
 * The command's statements, each without the commands git runs in it: a commit message is text git stores, and it may
 * name the label, a label write or `/land` without doing any of it. What a pipe or `&` joins to a git command stays.
 */
function statementsOf(command: string): string[] {
  return pieces(command, /;|&&|\|\||\n/u)
    .map((statement) =>
      pieces(statement, /\||&/u)
        .filter((piece) => nameOf(programWords(piece)[0] ?? "") !== "git")
        .join(" | "),
    )
    .filter((statement) => statement !== "");
}

function runsHook(command: string): boolean {
  return pieces(command, /;|&&|\|\||\||\n/u).some((piece) => {
    const [program = "", ...rest] = programWords(piece);

    if (HOOK_FILE.test(program)) return true;

    return (
      INTERPRETERS.has(nameOf(program)) &&
      HOOK_FILE.test(rest.find((word) => word !== "run" && !word.startsWith("-")) ?? "")
    );
  });
}

function sendsARequest(statement: string): boolean {
  if (GH_GRAPHQL.test(statement)) return MUTATION.test(statement);

  return (
    (GH_API.test(statement) && GH_API_WRITES.test(statement)) ||
    (CURL.test(statement) && CURL_WRITES.test(statement))
  );
}

function writesLabels(statement: string): boolean {
  return GH_LABEL_WRITERS.some((writer) => writer.test(statement)) || sendsARequest(statement);
}

/** The label a statement writes is not in its text: an expanded label option or name, or a request's expanded body. */
function takesItsLabelFromElsewhere(statement: string): boolean {
  return (
    EXPANDED_LABEL.test(statement) ||
    (GH_LABEL.test(statement) && EXPANDS.test(statement)) ||
    (sendsARequest(statement) && EXPANDS_OR_READS_A_HEREDOC.test(statement))
  );
}

/** A statement that writes labels and names `land-ok`, or takes its label from elsewhere on a line that names it. */
function putsLabelOn(statements: readonly string[]): boolean {
  const isNamed = statements.some((statement) => LABEL.test(statement));

  return statements.some(
    (statement) =>
      writesLabels(statement) &&
      (LABEL.test(statement) || (isNamed && takesItsLabelFromElsewhere(statement))),
  );
}

/** Why the command is denied, or null when it passes. */
export function refusal(command: string): string | null {
  const statements = statementsOf(command);
  const text = statements.join("\n");

  if (putsLabelOn(statements)) {
    return `guard-land-ok: land-ok is the human's ok on a pull request, and this command writes labels and names it. ${ASK}`;
  }

  if (runsHook(command)) {
    return `guard-land-ok: land-label.ts is Claude Code's to run, on the /land the human typed: run by hand, it puts land-ok on from whatever payload it reads. ${ASK}`;
  }

  if (TYPED_LAND.test(text) && (SESSION_PROGRAM.test(text) || SESSION_SCRIPT.test(text))) {
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
