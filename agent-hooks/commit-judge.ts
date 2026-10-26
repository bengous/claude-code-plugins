import { tmpdir } from "node:os";

import type { Deadline, RunResult, Runner } from "./exec.ts";
import { isRecord, stringField } from "./json.ts";

/**
 * What a `git commit` does with its message: `new`, a commit with a message of its own; `amend`, an amend that writes
 * a new one; `kept`, no new message (`--no-edit`, which keeps an amend's or concludes a merge, a message reused with
 * `-C` or `--fixup=amend:`) or no commit at all (`--dry-run`, `--porcelain`, `-h`).
 */
export type CommitForm = "new" | "amend" | "kept";

export type CommitMessage = {
  readonly form: CommitForm;
  /** The message as written: the `-m` values, or the heredoc `-F -` reads; null when a file holds it, or none shows. */
  readonly message: string | null;
  /** The file `-F` names, read where the commit runs. */
  readonly file: string | null;
};

/** Options of `git commit` that take a value, as the next word or after `=`. */
const VALUE_OPTIONS = new Set([
  "-m",
  "--message",
  "-F",
  "--file",
  "-C",
  "--reuse-message",
  "-c",
  "--reedit-message",
  "-t",
  "--template",
  "--author",
  "--date",
  "--cleanup",
  "--trailer",
  "--fixup",
  "--squash",
  "--pathspec-from-file",
]);

/** Short options of `git commit` that take a value, attached or as the next word. */
const SHORT_VALUE_OPTIONS = new Set(["m", "F", "C", "c", "t"]);

/** Short options whose value, optional, can only be attached: the rest of the cluster (`-S<keyid>`, `-u<mode>`). */
const SHORT_ATTACHED_OPTIONS = new Set(["S", "u"]);

/** The names `-F` takes for the command's stdin, which the heredoc fills. */
const STDIN = new Set(["-", "/dev/stdin"]);

const REUSED_MESSAGE = new Set(["-C", "--reuse-message", "-c", "--reedit-message"]);

const NO_COMMIT = new Set(["--dry-run", "--short", "--porcelain", "--long", "--help", "-h"]);

const HEREDOC_BODY = /<<-?\s*\\?(['"]?)(\w+)\1[^\n]*\n([\s\S]*?)\n\s*\2\s*(?:\n|$)/u;

/** What a `git commit` does with its message, from its arguments as Bash hands them over and the heredoc it reads. */
export function commitMessageOf(args: readonly string[], heredoc: string | null): CommitMessage {
  let amend = false;
  let noEdit = false;
  let reused = false;
  let none = false;
  let file: string | null = null;
  const messages: string[] = [];

  const take = (name: string, value: string | undefined): void => {
    if (value === undefined) {
      return;
    }

    if (name === "-m" || name === "--message") {
      messages.push(value);
    } else if (name === "-F" || name === "--file") {
      file = value;
    }

    reused ||=
      REUSED_MESSAGE.has(name) || (name === "--fixup" && /^(?:amend|reword):/u.test(value));
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";

    if (arg === "--") {
      break;
    }

    none ||= NO_COMMIT.has(arg.split("=")[0] ?? arg);

    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      const name = equals === -1 ? arg : arg.slice(0, equals);
      amend ||= name === "--amend";
      noEdit ||= name === "--no-edit";

      if (VALUE_OPTIONS.has(name)) {
        take(name, equals === -1 ? args[index + 1] : arg.slice(equals + 1));
        index += equals === -1 ? 1 : 0;
      }
    } else if (arg.startsWith("-") && arg.length > 1) {
      for (let at = 1; at < arg.length; at += 1) {
        const letter = arg[at] ?? "";
        const attached = arg.slice(at + 1);

        if (SHORT_VALUE_OPTIONS.has(letter)) {
          take(`-${letter}`, attached === "" ? args[index + 1] : attached);
          index += attached === "" ? 1 : 0;
          break;
        }

        if (SHORT_ATTACHED_OPTIONS.has(letter)) {
          break;
        }
      }
    }
  }

  const written = messages.flatMap((message) => {
    const text = message.startsWith("$(") ? HEREDOC_BODY.exec(message)?.[3] : message;

    return text === undefined ? [] : [text.trim()];
  });

  const stdin = file !== null && STDIN.has(file);
  const fromStdin: string | null = stdin ? (heredoc?.trim() ?? null) : null;
  const named: string | null = stdin ? null : file;
  const message = written.length > 0 ? written.join("\n\n") : fromStdin;
  const writes = messages.length > 0 || file !== null;

  const form: CommitForm =
    none || reused || ((amend || noEdit) && !writes) ? "kept" : amend ? "amend" : "new";

  return { form, message, file: named };
}

/** The instructions the judge was measured with: changing them invalidates the measurement (see SKILL.md). */
export const JUDGE_PROMPT = `You check the message of a git commit a coding agent is about to make. A commit message describes the change in terms of the code: what the code does now, and why, as facts about the code, its users or its constraints. It must stay true for someone reading the history years later, once the pull request, the review tool, the chat and the sessions are gone. How the change came to be, and how it was checked, belong in the pull request.

Read the subject and every sentence of the body. List each passage that could break the rule, and give each one a kind:
- "process": it explains the change by what produced it: a review, a second review, an audit, their findings or points, a round of feedback, a handoff, a decision or request of a lead, the user or a teammate, a session, a conversation, a plan step or decision label ("(D5)", "plan 1.5"), an eval iteration label ("hillclimb v2").
- "check-event": it reports a check as an event, a result obtained at one moment or against another version than this commit's own: a test seen red or failing before the fix, before/after numbers, a mutant that was applied, a check in a browser, a trial, a pilot, a live run that found the defect, an eval round with its scores or cost, who reviewed or signed the change.
- "fact": anything a reader can check on this commit's tree alone, in the present tense: the defect itself, even told in the past tense as what the old code did ("check said ok", "the band read X"), as long as no date, count of occurrences, run or job id, or session is attached; an instruction about when to land or install the commit; what a test feeds in, asserts, guards against or cannot see; the words review, audit, session or eval when the change itself is about that thing, as the files show (a review gate and its risky paths, a script holding an audit's baseline, a session object, an eval suite's own files); a measured fact about a dependency or platform that explains why the code is as it is; an external bug report cited as evidence; a bare issue or pull request number.
A statistic, a dataset, a period or a score given to justify a choice is a "check-event"; the reason said in words, with the kind of source named and no figure ("most gaps in the local transcripts run under a quarter of an hour"), is a "fact".
A defect told under the condition that shows it ("the test timed out at 5 s under a parallel run") is a "fact".

Examples from this repository:
- "fix(scripts): release answers the second review of #376" → process
- "The review of #344 found that the proxy defeats the app's DNS-rebind protection." → process (the fact alone, "the proxy defeated the app's DNS-rebind protection", would pass)
- "so the Vite path goes, as decided (D5)" → process
- "The new test was seen red first" → check-event
- "Checked in a browser on the sample: #orders reads path [server, app]" → check-event
- "1.4 s before, about 40 ms after" → check-event
- "Specs run on the sample, on a map five levels deep and on ten seeded random maps" → fact (what the tests feed in)
- "an assertion that fails without the escape" → fact (what the assertion guards against)
- "The specs missed it: script-made pointers skip the capture" → fact (what the tests cannot see)
- "the e2e gate, the release guard and the release's coming scripts land only after a clean review", touching .claude/agent-hooks.jsonc → fact (the change configures the review gate)
- "measured on Bun 1.4.3, Linux: --config=<file> keeps the file" → fact
- "a swatch the browser rejects was painted black and check said ok" → fact (the defect, what the old code did)
- "This line waits until the catalog installs 1.4.0" → fact (a landing instruction)
- "Its 202 requests ran just over Bun's 5s default (5004, 5072, 5178 ms on runs 39396636833, 39412501611)" → check-event (run ids attached)
- "who ran 17 destructive git commands by hand in four weeks" → check-event (a counted event)

You get the message, then the files the commit touches. Answer with one JSON object and nothing else:
{"passages": [{"quote": "<verbatim words>", "kind": "process" | "check-event" | "fact"}], "reason": "<one sentence>"}
An empty list means nothing could break the rule.`;

/** The kinds of passage a commit message may not hold. */
export type FaultKind = "process" | "check-event";

export type Fault = { readonly kind: FaultKind; readonly quote: string };

/** Haiku's reading of one message: the passages that break the rule, none when it passes; or why it gave none. */
export type Judgment =
  | { readonly kind: "answered"; readonly faults: readonly Fault[] }
  | { readonly kind: "failed"; readonly why: string };

/** Leaves the judge that much time to exit once killed, and the hook that much to encode its answer. */
const JUDGE_MARGIN_MS = 2000;

/** Past this many, the files the commit touches are cut: they are context, not the thing judged. */
const MAX_FILES = 200;

/** What Haiku reads: the message, then the files the commit touches. */
export function judgeInput(message: string, files: readonly string[]): string {
  const shown = files.slice(0, MAX_FILES);
  const more = files.length > shown.length ? [`… and ${files.length - shown.length} more`] : [];

  return `Message:\n${message}\n\nFiles:\n${[...shown, ...more].join("\n")}`;
}

/**
 * Asks Haiku, headless, with no tool, no hook, no MCP server and no saved session, which passages of the message tell
 * how the change came about or how it was checked. An answer it cannot read is asked once more while time is left.
 */
export async function judge(
  message: string,
  files: readonly string[],
  deadline: Deadline,
  runner: Runner,
): Promise<Judgment> {
  let failed: Judgment = { kind: "failed", why: "no time left before the hook's deadline" };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const timeoutMs = deadline.remaining() - JUDGE_MARGIN_MS;

    if (timeoutMs <= 0) {
      return failed;
    }

    const result = await runner(
      [
        "claude",
        "-p",
        "--model",
        "haiku",
        "--output-format",
        "json",
        "--tools",
        "",
        "--no-session-persistence",
        "--strict-mcp-config",
        "--settings",
        '{"disableAllHooks":true}',
        "--system-prompt",
        JUDGE_PROMPT,
        judgeInput(message, files),
      ],
      { cwd: tmpdir(), timeoutMs },
    );

    const judgment = judgmentOf(result);

    if (judgment.kind === "answered" || result.kind !== "exited") {
      return judgment;
    }

    failed = judgment;
  }

  return failed;
}

function judgmentOf(result: RunResult): Judgment {
  switch (result.kind) {
    case "missing": {
      return { kind: "failed", why: "claude is not on PATH" };
    }

    case "timedOut": {
      return { kind: "failed", why: `no answer within ${result.timeoutMs} ms` };
    }

    case "exited": {
      const faults = result.code === 0 ? faultsIn(result.stdout) : null;

      return faults === null
        ? { kind: "failed", why: `claude -p exited ${result.code} with no readable answer` }
        : { kind: "answered", faults };
    }

    default: {
      const unreachable: never = result;
      throw new Error(`unhandled run: ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * The faulty passages in `claude -p --output-format json`'s output: its result message, alone or the last of the
 * array the user's `verbose` setting prints, holds Haiku's JSON object. Null when that object has no passage list.
 */
function faultsIn(stdout: string): Fault[] | null {
  try {
    const output: unknown = JSON.parse(stdout);

    const message = Array.isArray(output)
      ? output.findLast((item) => isRecord(item) && item["type"] === "result")
      : output;

    const result = isRecord(message) ? stringField(message, "result") : undefined;
    const answer: unknown = JSON.parse(/\{[\s\S]*\}/u.exec(result ?? "")?.[0] ?? "null");
    const passages = isRecord(answer) ? answer["passages"] : undefined;

    if (!Array.isArray(passages)) {
      return null;
    }

    return passages.flatMap((passage): Fault[] => {
      const kind = isRecord(passage) ? stringField(passage, "kind") : undefined;
      const quote = isRecord(passage) ? (stringField(passage, "quote") ?? "") : "";

      return kind === "process" || kind === "check-event" ? [{ kind, quote }] : [];
    });
  } catch {
    return null;
  }
}

const FAULT_WORDS: Readonly<Record<FaultKind, string>> = {
  process: "how the change came about",
  "check-event": "how it was checked",
};

/** The refusal of the commits whose messages hold faults, each named by its subject when there are several. */
export function judgeRefusal(
  refused: readonly { message: string; faults: readonly Fault[] }[],
): string {
  const several = refused.length > 1;

  const lines = refused.flatMap(({ message, faults }) => [
    ...(several ? [`In "${message.split("\n")[0] ?? ""}":`] : []),
    ...faults.map((fault) => `- "${fault.quote}" (${FAULT_WORDS[fault.kind]})`),
  ]);

  return [
    `agent-hooks: ${several ? "these commit messages tell" : "this commit message tells"} how the change came about or how it was checked, which goes in the pull request, not in the history:`,
    ...lines,
    "A commit message says what the code does and why, the reason in words. Rewrite these passages, or rerun exactly the same command if the message is right.",
  ].join("\n");
}
