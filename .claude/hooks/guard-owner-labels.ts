#!/usr/bin/env bun

/**
 * PreToolUse hook for Bash: keeps the factory's three owner moves the owner's. `human-approved` clears the
 * owner gate of a pull request, `ready` starts a cloud session on an issue, and taking `needs-human` off
 * restarts a pull request the factory stopped. The workflows accept each from the owner's login, and a session
 * on the owner's machine writes under it: `gh` holds the owner's token there. This hook denies such a
 * session's command that makes one of the three moves.
 *
 * It reads the command as text, with no shell parser: a command that spells the label some other way, a
 * label's node id in a GraphQL mutation for one, goes through, and no workflow tells it from the owner's.
 */

import { isRecord, recordField, stringField } from "../../agent-hooks/core/util/json.ts";
import { messageOf } from "../../tools/platform/pure.ts";
import { HOOK_EXIT } from "./hook-io.ts";

type Move = "add" | "remove";

interface OwnerMove {
  readonly label: string;
  readonly move: Move;
  readonly effect: string;
}

const OWNER_MOVES: readonly OwnerMove[] = [
  { label: "human-approved", move: "add", effect: "it clears the owner gate of a pull request" },
  { label: "ready", move: "add", effect: "it starts a cloud session on an issue" },
  {
    label: "needs-human",
    move: "remove",
    effect: "off, it restarts a pull request the factory stopped",
  },
];

const ASK = "Ask the owner: the move is his, made on GitHub.";

/** A heredoc's opening, its delimiter bare or quoted; `<<<` opens none. */
const HEREDOC = /(?<!<)<<(-?)\s*(?:"([A-Za-z_]\w*)"|'([A-Za-z_]\w*)'|\\?([A-Za-z_]\w*))/u;

/** What stands for a heredoc in the command once its body is set aside, with the body's index. */
const HEREDOC_MARK = "<<heredoc#";

const MARKED_HEREDOC = /<<heredoc#(\d+)/gu;

const QUOTED = String.raw`(?:"(?:[^"\\]|\\.)*"|'[^']*')`;

/**
 * The quoted prose a command carries: a body, a title, a commit message. It may name a label or a label write
 * without doing any of it.
 */
const PROSE: readonly RegExp[] = [
  new RegExp(
    String.raw`(?<=(?:^|\s)(?:--body|--title|--notes|--message|--comment|--subject|--description|-b|-t|-m)(?:\s+|=))${QUOTED}`,
    "gu",
  ),
  new RegExp(
    String.raw`(?<=(?:^|\s)(?:-f|-F|--field|--raw-field)(?:\s+|=))(?:(?:body|title)=${QUOTED}|"(?:body|title)=(?:[^"\\]|\\.)*"|'(?:body|title)=[^']*')`,
    "gu",
  ),
  // `-c` is a comment on these commands alone: after `bash`, it is the command to run.
  new RegExp(
    String.raw`(?<=\bgh\s+(?:pr|issue)\s+(?:close|reopen)\b[^\n;|&]*\s-c(?:\s+|=))${QUOTED}`,
    "gu",
  ),
];

/** A label option and its value; `--label` and `-l` write only on a `create`, and filter a `list`. */
const LABEL_OPTION =
  /(?:^|\s)(--add-label|--remove-label|--label|-l)(?:\s+|=)(?:"([^"]*)"|'([^']*)'|(\S+))/gu;

const GH_CREATE = /\bgh\s+(?:pr|issue)\s+create\b/u;

const GH_API = /\bgh\s+api\b/u;

const GH_API_WRITES =
  /(?:^|\s)(?:(?:-X|--method)[\s=]*(?:POST|PUT|PATCH|DELETE)\b|(?:-f|-F|--field|--raw-field|--input)(?=[\s=]|$))/iu;

/** `gh api` sends its fields as a query string once the method is GET. */
const GH_API_GETS = /(?:^|\s)(?:-X|--method)[\s=]*GET\b/iu;

const CURL = /\bcurl\b/u;

/** `gh label edit` and `delete` change a label on every issue that carries it. */
const GH_LABEL_REWRITES = /\bgh\s+label\s+(?:edit|delete)\b/u;

/** A GraphQL call carries its query in a field: it writes only when the query is a mutation. */
const GRAPHQL = /(?:^|\s)graphql(?=\s|$)/u;

const MUTATION = /\bmutation\b/u;

/** `-d` and `-F` take their value glued to them, and either makes the request a POST. */
const CURL_WRITES =
  /(?:^|\s)(?:(?:-X|--request)[\s=]*(?:POST|PUT|PATCH|DELETE)\b|-[dF]|(?:--data[\w-]*|--form[\w-]*|--json)(?=[\s=]|$))/u;

/** The request's body is what the command is fed: a pipe before it, or its heredoc. */
const BODY_FROM_STDIN = /(?:^|\s)(?:--input[\s=]+-|(?:-d|--data[\w-]*|--json)[\s=]*@-)(?=\s|$)/u;

const DELETES = /(?:^|\s)(?:-X|--method|--request)[\s=]*DELETE\b/iu;

const PUTS = /(?:^|\s)(?:-X|--method|--request)[\s=]*PUT\b/iu;

const PATCHES = /(?:^|\s)(?:-X|--method|--request)[\s=]*PATCH\b/iu;

/** Where a request writes labels: the labels of an issue, a `labels` field, or a label mutation. */
const LABELS_PATH = /\/labels(?=$|[\s"'/?])/u;

const LABELS_FIELD = /\blabels(?:\[\])?=/u;

const LABELS_KEY = /"labels"\s*:/u;

const LABEL_MUTATION = /LabelsToLabelable|labelIds/u;

/** The labels of one issue as a set: a PUT there replaces them, a DELETE clears them. */
const LABEL_SET_PATH = /\/issues\/[^\s/"']+\/labels(?=$|[\s"'?])/u;

const EXPANDS = /[$`]/u;

/** The programs whose words are text they print or store, and no command. */
const SPEAKERS = new Set(["git", "echo", "printf"]);

/** A value a variable holds, and the words a `for` loop hands out one by one. */
const HELD: readonly RegExp[] = [
  new RegExp(String.raw`(?:^|[\s;(])[A-Za-z_]\w*=(${QUOTED}|[^\s;)]*)`, "gu"),
  /\bfor\s+\w+\s+in\s+([^;\n]*)/gu,
];

/** The words that run the command after them: skipped, with their options and a `timeout`'s duration. */
const WRAPPERS = new Set(["env", "timeout", "nice", "time", "command", "exec", "nohup"]);

const ASSIGNMENT = /^[A-Za-z_]\w*=/u;

const DURATION = /^\d+(?:\.\d+)?[smhd]?$/u;

/** One command of a pipeline, with what its statement is fed: the pipeline's text and its heredocs' bodies. */
interface Piece {
  readonly text: string;
  readonly fed: string;
}

interface LabelWrite {
  readonly move: Move;
  /** The text that holds the label: an option's value, or a request with its body. */
  readonly text: string;
  /** The label is not in that text: Bash expands it. */
  readonly expanded: boolean;
}

interface Heredocs {
  readonly text: string;
  readonly bodies: readonly string[];
}

function split(text: string, breaks: RegExp): string[] {
  return text
    .split(breaks)
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

function nameOf(word: string): string {
  return word.split("/").at(-1) ?? "";
}

/** The program a piece runs: assignments and wrappers before it are skipped. */
function programOf(piece: string): string {
  const words = piece.split(/[\s<>]+/u).map((word) => word.replaceAll(/["']/gu, ""));

  return nameOf(
    words.find(
      (word) =>
        !ASSIGNMENT.test(word) &&
        !WRAPPERS.has(nameOf(word)) &&
        !DURATION.test(word) &&
        !word.startsWith("-"),
    ) ?? "",
  );
}

interface OpenHeredoc {
  readonly end: string;
  /** `<<-` lets tabs stand before the closing delimiter; `<<` wants it alone on its line. */
  readonly indented: boolean;
  readonly opening: string;
  readonly lines: string[];
}

function closes(line: string, heredoc: OpenHeredoc): boolean {
  return (heredoc.indented ? line.replace(/^\t+/u, "") : line) === heredoc.end;
}

/**
 * The command with each heredoc's body set aside: a body is data, and its lines are no statements. A `<<word`
 * no line closes opened none, in a quoted string or a shift for two: its lines stay statements.
 */
function heredocsOf(command: string): Heredocs {
  const kept: string[] = [];
  const bodies: string[] = [];
  let open: OpenHeredoc | null = null;

  for (const line of command.split("\n")) {
    if (open !== null) {
      if (closes(line, open)) {
        kept.push(open.opening.replace(HEREDOC, `${HEREDOC_MARK}${bodies.length}`));
        bodies.push(open.lines.join("\n"));
        open = null;
      } else {
        open.lines.push(line);
      }

      continue;
    }

    const opening = HEREDOC.exec(line);

    if (opening === null) {
      kept.push(line);

      continue;
    }

    open = {
      end: opening[2] ?? opening[3] ?? opening[4] ?? "",
      indented: opening[1] === "-",
      opening: line,
      lines: [],
    };
  }

  if (open !== null) kept.push(open.opening, ...open.lines);

  return { text: kept.join("\n"), bodies };
}

/** A quoted value over several lines is one word of its command: a newline in it ends no statement. */
function onOneLine(text: string): string {
  return text.replaceAll(new RegExp(QUOTED, "gu"), (quoted) => quoted.replaceAll("\n", " "));
}

/**
 * The commands the text runs, without its prose and without those of a program that only prints or stores its
 * words, a commit message for one. What a pipe or `&` joins to such a command stays.
 */
function piecesOf(text: string, bodies: readonly string[]): Piece[] {
  return split(text, /;|&&|\|\||\n/u).flatMap((statement) => {
    const fed = [
      statement,
      ...[...statement.matchAll(MARKED_HEREDOC)].map((mark) => bodies[Number(mark[1])] ?? ""),
    ].join("\n");

    return split(statement, /\||&/u)
      .filter((piece) => !SPEAKERS.has(programOf(piece)))
      .map((piece) => ({ text: piece, fed }));
  });
}

/** The label as a whole name: `ready` is one, `ready-to-read` and `already` are not. */
function namedIn(label: string, text: string): boolean {
  return new RegExp(String.raw`(?:^|[\s=,"'\[:/(]|:-)${label}(?=$|[\s,"'\];)<>|&}])`, "iu").test(
    text,
  );
}

function heldIn(label: string, text: string): boolean {
  return HELD.some((held) =>
    [...text.matchAll(held)].some((match) => namedIn(label, match[1] ?? "")),
  );
}

function optionWrites(piece: Piece): LabelWrite[] {
  const creates = GH_CREATE.test(piece.text);

  return [...piece.text.matchAll(LABEL_OPTION)].flatMap((match) => {
    const [, option = "", double, single, bare] = match;
    const onCreate = option === "--label" || option === "-l";

    if (onCreate && !creates) return [];

    const text = double ?? single ?? bare ?? "";

    return [
      { move: option === "--remove-label" ? "remove" : "add", text, expanded: EXPANDS.test(text) },
    ];
  });
}

function sendsARequest(piece: string): boolean {
  if (GH_API.test(piece) && GRAPHQL.test(piece)) return MUTATION.test(piece);

  return (
    (GH_API.test(piece) && GH_API_WRITES.test(piece) && !GH_API_GETS.test(piece)) ||
    (CURL.test(piece) && CURL_WRITES.test(piece))
  );
}

/** A request with its body, when the body is what the command is fed. */
function requestOf(piece: Piece): string | null {
  if (!sendsARequest(piece.text)) return null;

  return BODY_FROM_STDIN.test(piece.text) ? piece.fed : piece.text;
}

function requestWrites(piece: Piece): LabelWrite[] {
  const request = requestOf(piece);

  if (request === null) return [];

  const writesLabels =
    LABELS_PATH.test(piece.text) ||
    LABELS_FIELD.test(piece.text) ||
    LABELS_KEY.test(request) ||
    LABEL_MUTATION.test(request);

  if (!writesLabels) return [];

  return [
    {
      move: DELETES.test(piece.text) ? "remove" : "add",
      text: request,
      expanded: EXPANDS.test(piece.text),
    },
  ];
}

/** A request that leaves an issue with the labels it names alone, or with none: `needs-human` goes with the rest. */
function replacesTheLabels(piece: Piece): boolean {
  const request = requestOf(piece);

  if (request === null) return false;

  return (
    ((PUTS.test(piece.text) || DELETES.test(piece.text)) && LABEL_SET_PATH.test(piece.text)) ||
    (PATCHES.test(piece.text) && (LABELS_FIELD.test(piece.text) || LABELS_KEY.test(request)))
  );
}

/** The owner's label a `gh label edit` or `delete` names: as its target, or as the new name of another. */
function rewritten(piece: Piece): string | undefined {
  if (!GH_LABEL_REWRITES.test(piece.text)) return undefined;

  return OWNER_MOVES.find(({ label }) => namedIn(label, piece.text))?.label;
}

/** Why the command is denied, or null when it passes. */
export function refusal(command: string): string | null {
  const heredocs = heredocsOf(command);
  const continued = heredocs.text.replaceAll("\\\n", " ");
  const acted = onOneLine(PROSE.reduce((text, prose) => text.replaceAll(prose, '""'), continued));
  const pieces = piecesOf(acted, heredocs.bodies);
  const writes = pieces.flatMap((piece) => [...optionWrites(piece), ...requestWrites(piece)]);

  for (const { label, move, effect } of OWNER_MOVES) {
    const made = writes.some(
      (write) =>
        write.move === move &&
        (namedIn(label, write.text) || (write.expanded && heldIn(label, acted))),
    );

    if (made) {
      const verb = move === "add" ? "put on" : "take off";

      return `guard-owner-labels: ${label} is the owner's to ${verb}: ${effect}. ${ASK}`;
    }
  }

  const renamed = pieces.map((piece) => rewritten(piece)).find((label) => label !== undefined);

  if (renamed !== undefined) {
    return `guard-owner-labels: this command renames or deletes a label, and ${renamed} goes on or comes off every issue at once, a move the workflows read as the owner's. ${ASK}`;
  }

  if (pieces.some((piece) => replacesTheLabels(piece))) {
    return `guard-owner-labels: this request replaces or clears every label of an issue, and needs-human goes with them, which the owner alone takes off. Add or remove a label by its name: gh issue edit --add-label, --remove-label.`;
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
    console.error(`guard-owner-labels: ${messageOf(error)}`);
    process.exit(HOOK_EXIT.ERROR);
  }
}
