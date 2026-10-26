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
  /**
   * The message as written: the `-m` values, or the heredoc `-F -` reads, then the `--trailer` values; null when a
   * file holds it, or none shows.
   */
  readonly message: string | null;
  /** The file `-F` names, read where the commit runs. */
  readonly file: string | null;
  /** The `--trailer` values, which git appends to a message `-F` reads from a file too. */
  readonly trailers: readonly string[];
  /**
   * Whether part of the message is known only once the line runs: a `-m`, `--trailer` or `-F` value Bash expands
   * (`"$MSG"`, `"$(cat msg.txt)"`, backticks) other than a literal heredoc read by `cat`, or a `-F -` fed by a pipe
   * or by a heredoc Bash expands.
   */
  readonly opaque: boolean;
  /**
   * What the commit takes: `staged`, the index; `worktree`, the tracked files as they are on disk, for `-a` or
   * pathspecs.
   */
  readonly takes: "staged" | "worktree";
};

/** How Bash treats the words `commitMessageOf` reads, as `commitsOf` found them. */
export type CommitExpansion = {
  /** For each argument, whether Bash expands part of it when the line runs. */
  readonly argsExpand: readonly boolean[];
  /** Whether Bash expands the heredoc the command reads. */
  readonly heredocExpands: boolean;
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

/** The long options of `git commit`, as `git commit --git-completion-helper` lists them: git takes any unique prefix. */
const LONG_OPTIONS = [
  "--quiet",
  "--verbose",
  "--file",
  "--author",
  "--date",
  "--message",
  "--reedit-message",
  "--reuse-message",
  "--fixup",
  "--squash",
  "--reset-author",
  "--trailer",
  "--signoff",
  "--template",
  "--edit",
  "--cleanup",
  "--status",
  "--gpg-sign",
  "--all",
  "--include",
  "--interactive",
  "--patch",
  "--unified",
  "--inter-hunk-context",
  "--only",
  "--no-verify",
  "--dry-run",
  "--short",
  "--branch",
  "--ahead-behind",
  "--porcelain",
  "--long",
  "--null",
  "--amend",
  "--no-post-rewrite",
  "--untracked-files",
  "--pathspec-from-file",
  "--pathspec-file-nul",
  "--verify",
  "--post-rewrite",
  "--no-quiet",
  "--no-verbose",
  "--no-file",
  "--no-author",
  "--no-date",
  "--no-message",
  "--no-reedit-message",
  "--no-reuse-message",
  "--no-fixup",
  "--no-squash",
  "--no-reset-author",
  "--no-trailer",
  "--no-signoff",
  "--no-template",
  "--no-edit",
  "--no-cleanup",
  "--no-status",
  "--no-gpg-sign",
  "--no-all",
  "--no-include",
  "--no-interactive",
  "--no-patch",
  "--no-only",
  "--no-dry-run",
  "--no-short",
  "--no-branch",
  "--no-ahead-behind",
  "--no-porcelain",
  "--no-long",
  "--no-null",
  "--no-amend",
  "--no-untracked-files",
  "--no-pathspec-from-file",
  "--no-pathspec-file-nul",
];

/**
 * The long option `name` stands for: itself, or the one option it is a prefix of. An ambiguous prefix is left as it
 * is: git refuses it, and no commit runs.
 */
function longOption(name: string): string {
  const matches = LONG_OPTIONS.filter((option) => option.startsWith(name));

  return LONG_OPTIONS.includes(name) || matches.length !== 1 ? name : (matches[0] ?? name);
}

/** Short options of `git commit` that take a value, attached or as the next word. */
const SHORT_VALUE_OPTIONS = new Set(["m", "F", "C", "c", "t"]);

/** Short options whose value, optional, can only be attached: the rest of the cluster (`-S<keyid>`, `-u<mode>`). */
const SHORT_ATTACHED_OPTIONS = new Set(["S", "u"]);

/** The names `-F` takes for the command's stdin, which the heredoc fills. */
const STDIN = new Set(["-", "/dev/stdin"]);

const REUSED_MESSAGE = new Set(["-C", "--reuse-message", "-c", "--reedit-message"]);

const NO_COMMIT = new Set(["--dry-run", "--short", "--porcelain", "--long", "--help", "-h"]);

/** A value that is a heredoc read by `cat` and nothing else: `"$(cat <<'EOF'` … `EOF` `)"`. */
const CAT_HEREDOC =
  /^\$\(\s*cat\s+<<-?\s*(\\)?(['"]?)(\w+)\2[ \t]*\n([\s\S]*?)\n[ \t]*\3[ \t]*\n?\s*\)$/u;

/**
 * A `-m` or `--trailer` value as Bash hands it over, or undefined when only the line's run gives it. A heredoc
 * delimiter quoted or escaped (`'EOF'`, `"EOF"`, `\EOF`) keeps its body literal.
 */
function textOf(value: string, expands: boolean): string | undefined {
  if (!expands) {
    return value;
  }

  const [, backslash, quote, , body] = CAT_HEREDOC.exec(value) ?? [];
  const literal = backslash !== undefined || (quote !== undefined && quote !== "");

  return body === undefined || (!literal && /[$`]/u.test(body)) ? undefined : body;
}

/** A message with its `--trailer` values after it, as git appends them. */
export function withTrailers(body: string, trailers: readonly string[]): string {
  return trailers.length === 0 ? body : `${body}\n\n${trailers.join("\n")}`;
}

/** What a `git commit` does with its message, from its arguments as Bash hands them over and the heredoc it reads. */
export function commitMessageOf(
  args: readonly string[],
  heredoc: string | null,
  expansion: CommitExpansion,
): CommitMessage {
  let amend = false;
  let noEdit = false;
  let reused = false;
  let none = false;
  let all = false;
  let pathspec = false;
  let file: string | null = null;
  let fileExpands = false;
  const messages: (string | undefined)[] = [];
  const trailers: (string | undefined)[] = [];

  const take = (name: string, value: string | undefined, at: number): void => {
    if (value === undefined) {
      return;
    }

    const text = textOf(value, expansion.argsExpand[at] === true);

    if (name === "-m" || name === "--message") {
      messages.push(text);
    } else if (name === "--trailer") {
      trailers.push(text);
    } else if (name === "-F" || name === "--file") {
      file = value;
      fileExpands = expansion.argsExpand[at] === true;
    }

    reused ||=
      REUSED_MESSAGE.has(name) || (name === "--fixup" && /^(?:amend|reword):/u.test(value));
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";

    if (arg === "--") {
      pathspec ||= index + 1 < args.length;
      break;
    }

    const equals = arg.indexOf("=");

    const name = arg.startsWith("--")
      ? longOption(equals === -1 ? arg : arg.slice(0, equals))
      : arg;

    none ||= NO_COMMIT.has(arg.startsWith("--") ? name : (arg.split("=")[0] ?? arg));

    if (arg.startsWith("--")) {
      amend ||= name === "--amend";
      noEdit ||= name === "--no-edit";
      all ||= name === "--all";

      if (VALUE_OPTIONS.has(name)) {
        take(
          name,
          equals === -1 ? args[index + 1] : arg.slice(equals + 1),
          equals === -1 ? index + 1 : index,
        );
        index += equals === -1 ? 1 : 0;
      }
    } else if (arg.startsWith("-") && arg.length > 1) {
      for (let at = 1; at < arg.length; at += 1) {
        const letter = arg[at] ?? "";
        const attached = arg.slice(at + 1);
        all ||= letter === "a";

        if (SHORT_VALUE_OPTIONS.has(letter)) {
          take(
            `-${letter}`,
            attached === "" ? args[index + 1] : attached,
            attached === "" ? index + 1 : index,
          );
          index += attached === "" ? 1 : 0;
          break;
        }

        if (SHORT_ATTACHED_OPTIONS.has(letter)) {
          break;
        }
      }
    } else {
      pathspec = true;
    }
  }

  const stdin = file !== null && STDIN.has(file);
  const fromStdin = stdin && heredoc !== null && !expansion.heredocExpands ? heredoc.trim() : null;
  const written = messages.flatMap((text) => (text === undefined ? [] : [text.trim()]));
  const body = written.length > 0 ? written.join("\n\n") : fromStdin;
  const lines = trailers.flatMap((text) => (text === undefined ? [] : [text.trim()]));
  const writes = messages.length > 0 || file !== null;

  const form: CommitForm =
    none || reused || ((amend || noEdit) && !writes) ? "kept" : amend ? "amend" : "new";

  return {
    form,
    message: body === null ? null : withTrailers(body, lines),
    file: stdin ? null : file,
    trailers: lines,
    opaque:
      messages.includes(undefined) ||
      trailers.includes(undefined) ||
      (stdin && fromStdin === null) ||
      (!stdin && fileExpands),
    takes: all || pathspec ? "worktree" : "staged",
  };
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
 * how the change came about or how it was checked. An answer it cannot read is asked once more while time is left;
 * an error exit is not, as it would fail the same way.
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
      ],
      // On stdin, not as an argument: Linux caps one argument at 128 KiB, and a heredoc message is not capped.
      { cwd: tmpdir(), timeoutMs, stdin: judgeInput(message, files) },
    );

    const judgment = judgmentOf(result, message);

    if (judgment.kind === "answered" || result.kind !== "exited" || result.code !== 0) {
      return judgment;
    }

    failed = judgment;
  }

  return failed;
}

function judgmentOf(result: RunResult, message: string): Judgment {
  switch (result.kind) {
    case "missing": {
      return { kind: "failed", why: "claude is not on PATH" };
    }

    case "timedOut": {
      return { kind: "failed", why: `no answer within ${result.timeoutMs} ms` };
    }

    case "exited": {
      const faults = result.code === 0 ? faultsIn(result.stdout, message) : null;

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
 * array the user's `verbose` setting prints, holds Haiku's JSON object. Null when that object has no passage list. A
 * passage whose quote is not in the message, whitespace aside, is dropped: it would refuse over words the agent
 * cannot find.
 */
function faultsIn(stdout: string, message: string): Fault[] | null {
  const squashed = squash(message);

  try {
    const output: unknown = JSON.parse(stdout);

    const last = Array.isArray(output)
      ? output.findLast((item) => isRecord(item) && item["type"] === "result")
      : output;

    const result = isRecord(last) ? stringField(last, "result") : undefined;
    const answer: unknown = JSON.parse(/\{[\s\S]*\}/u.exec(result ?? "")?.[0] ?? "null");
    const passages = isRecord(answer) ? answer["passages"] : undefined;

    if (!Array.isArray(passages)) {
      return null;
    }

    return passages.flatMap((passage): Fault[] => {
      const kind = isRecord(passage) ? stringField(passage, "kind") : undefined;
      const quote = isRecord(passage) ? squash(stringField(passage, "quote") ?? "") : "";
      const found = quote !== "" && squashed.includes(quote);

      return found && (kind === "process" || kind === "check-event") ? [{ kind, quote }] : [];
    });
  } catch {
    return null;
  }
}

function squash(text: string): string {
  return text.replaceAll(/\s+/gu, " ").trim();
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
