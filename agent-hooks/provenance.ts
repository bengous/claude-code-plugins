/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type -- this module reads Claude Code's transcript, JSON lines whose shape the harness does not publish: each record is narrowed here by hand, and a record of another shape is skipped. */
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Deadline, Runner } from "./exec.ts";
import { isRecord, recordField, stringField } from "./json.ts";
import { AGENT_SEPARATOR } from "./state.ts";
import type { CommitMark } from "./state.ts";

/** What made the agent commit, as its trailer names it. */
export type Trigger = "review" | "human" | "self";

/** One fact of the transcript, at its record's position, in file order. */
type Event =
  | {
      readonly kind: "human";
      readonly at: number;
      readonly source: "user" | "brief" | "lead";
      readonly text: string;
    }
  | { readonly kind: "launch"; readonly at: number; readonly id: string }
  | {
      readonly kind: "notified";
      readonly at: number;
      readonly id: string;
      readonly status: string;
      readonly summary: string;
    }
  | { readonly kind: "reviewed"; readonly at: number; readonly what: string }
  | { readonly kind: "blocked"; readonly at: number; readonly hook: string; readonly text: string }
  | { readonly kind: "say"; readonly at: number; readonly text: string }
  | { readonly kind: "committed"; readonly at: number; readonly subject: string | null };

/** A transcript read for one commit: its facts, and what places them against the agent's previous commit. */
export type Transcript = {
  readonly events: readonly Event[];
  /** The time of each record, in ms since the epoch; a record without one takes the one before it. */
  readonly times: readonly number[];
  /** Whether a record carries the prompt the hook fired in: false while the transcript lags behind the turn. */
  readonly holdsPrompt: boolean;
};

export const REVIEW_SKILLS: ReadonlySet<string> = new Set([
  "code-review",
  "agents-bridge:adversarial-review",
]);

const INLINE_REVIEW_COMMAND = /<command-name>\/agents-bridge:adversarial-review<\/command-name>/u;

/** An `Agent` launch whose description says it reviews or audits: a heuristic, for want of a reviewer's type. */
const REVIEW_AGENT = /review|relecture|\breli[rst]e?\b|\brelis\b|audit/iu;

const HUMAN_SOURCES = new Set(["typed", "queued", "suggestion_accepted"]);

/** `auto-continuation` is the plan the user approved, sent back as the turn's prompt. */
const HUMAN_ORIGINS = new Set(["human", "auto-continuation"]);

const COMMIT_COMMAND = /(?:^|[;&|(]\s*|\s)git(?:\s+-C\s+\S+|\s+-c\s+\S+)*\s+commit\b/u;

/** The transcript of the agent a hook fired in: a subagent's sits under the session's, in `subagents/`. */
export function transcriptPathOf(
  transcriptPath: string,
  sessionId: string,
  agentId: string | undefined,
): string {
  return agentId === undefined
    ? transcriptPath
    : path.join(path.dirname(transcriptPath), sessionId, "subagents", `agent-${agentId}.jsonl`);
}

/** The value of `Agent-Session`: the session id, `<session>.<agent>` for a subagent. */
export function sessionValueOf(sessionId: string, agentId: string | undefined): string {
  return agentId === undefined ? sessionId : `${sessionId}${AGENT_SEPARATOR}${agentId}`;
}

/** Reads the transcript at `file`. Throws when it cannot be read; a line that does not parse is skipped. */
export function readTranscript(
  file: string,
  subagent: boolean,
  promptId: string | undefined,
): Transcript {
  const records = readFileSync(file, "utf8")
    .split("\n")
    .flatMap((line) => {
      if (line === "") {
        return [];
      }

      try {
        const record: unknown = JSON.parse(line);

        return isRecord(record) ? [record] : [];
      } catch {
        return [];
      }
    });

  let time = 0;

  const times = records.map((record) => {
    const parsed = Date.parse(stringField(record, "timestamp") ?? "");
    time = Number.isNaN(parsed) ? time : parsed;

    return time;
  });

  return {
    events: eventsOf(records, subagent),
    times,
    holdsPrompt:
      promptId !== undefined && records.some((record) => record["promptId"] === promptId),
  };
}

type Pending = {
  readonly kind: "skill" | "agent" | "commit";
  readonly what: string;
  readonly command: string;
};

/** The facts of a transcript's records, in file order. A subagent's first user message is its brief. */
export function eventsOf(records: readonly Record<string, unknown>[], subagent: boolean): Event[] {
  const events: Event[] = [];
  const pending = new Map<string, Pending>();
  let briefSeen = !subagent;

  for (const [at, record] of records.entries()) {
    const type = stringField(record, "type");
    const message = recordField(record, "message");
    const content = message?.["content"];

    if (type === "assistant" && Array.isArray(content)) {
      for (const block of content.filter((item) => isRecord(item))) {
        const text = stringField(block, "text");
        const input = recordField(block, "input") ?? {};
        const id = stringField(block, "id") ?? "";
        const name = stringField(block, "name");

        if (block["type"] === "text" && text !== undefined && text.trim() !== "") {
          events.push({ kind: "say", at, text });
        }

        if (block["type"] !== "tool_use") {
          continue;
        }

        const skill = stringField(input, "skill") ?? "";
        const description = stringField(input, "description") ?? "";
        const command = stringField(input, "command") ?? "";

        if (name === "Skill" && REVIEW_SKILLS.has(skill)) {
          pending.set(id, {
            kind: "skill",
            what: `Skill ${skill} ${stringField(input, "args") ?? ""}`.trim(),
            command: "",
          });
        } else if ((name === "Agent" || name === "Task") && REVIEW_AGENT.test(description)) {
          pending.set(id, { kind: "agent", what: `Agent "${description}"`, command: "" });
        } else if (name === "Bash" && COMMIT_COMMAND.test(command)) {
          pending.set(id, { kind: "commit", what: "", command });
        }
      }

      continue;
    }

    if (
      type === "user" &&
      Array.isArray(content) &&
      content.some((item) => isRecord(item) && item["type"] === "tool_result")
    ) {
      for (const block of content.filter((item) => isRecord(item))) {
        const call = pending.get(stringField(block, "tool_use_id") ?? "");

        if (block["type"] !== "tool_result" || call === undefined) {
          continue;
        }

        pending.delete(stringField(block, "tool_use_id") ?? "");
        const result = recordField(record, "toolUseResult") ?? {};
        const failed = block["is_error"] === true;

        if (call.kind === "commit") {
          if (!failed) {
            events.push({
              kind: "committed",
              at,
              subject: messageOf(call.command)?.split("\n")[0] ?? null,
            });
          }
        } else if (!failed) {
          const status = stringField(result, "status");
          const agentId = stringField(result, "agentId");

          const background =
            (status === "forked" && result["background"] === true) || status === "async_launched";

          if (background && agentId !== undefined) {
            events.push({ kind: "launch", at, id: agentId });
          } else if (call.kind === "skill" || status === "completed") {
            events.push({ kind: "reviewed", at, what: call.what });
          }
        }
      }

      continue;
    }

    const recordContent = record["content"];

    if (type === "system" && typeof recordContent === "string") {
      const launch = forkedLaunchOf(recordContent);

      if (launch !== null) {
        events.push({ kind: "launch", at, id: launch });
      }

      continue;
    }

    const attachment = recordField(record, "attachment");

    if (type === "attachment" && attachment?.["type"] === "hook_blocking_error") {
      const hook = stringField(attachment, "hookEvent") ?? "";
      const error = recordField(attachment, "blockingError");

      if (hook === "Stop" || hook === "SubagentStop") {
        events.push({
          kind: "blocked",
          at,
          hook,
          text: (error === undefined ? undefined : stringField(error, "blockingError")) ?? "",
        });
      }

      continue;
    }

    const notice =
      type === "attachment" && attachment?.["type"] === "queued_command"
        ? (stringField(attachment, "prompt") ?? "")
        : type === "user" && typeof content === "string"
          ? content
          : "";

    if (notice.includes("<task-notification>")) {
      events.push(...notificationsOf(notice, at));
      continue;
    }

    if (type === "user" && record["isMeta"] !== true) {
      const text =
        typeof content === "string"
          ? content
          : textOf(Array.isArray(content) ? content.filter((block) => isRecord(block)) : []);

      const origin = recordField(record, "origin");

      const human =
        HUMAN_SOURCES.has(stringField(record, "promptSource") ?? "") ||
        HUMAN_ORIGINS.has((origin === undefined ? undefined : stringField(origin, "kind")) ?? "");

      if (!briefSeen) {
        briefSeen = true;
        events.push({ kind: "human", at, source: "brief", text });
      } else if (subagent && text.startsWith("<teammate-message")) {
        events.push({ kind: "human", at, source: "lead", text });
      } else if (human) {
        events.push({ kind: "human", at, source: "user", text });
      }

      if (human && INLINE_REVIEW_COMMAND.test(text)) {
        events.push({ kind: "reviewed", at, what: "/agents-bridge:adversarial-review" });
      }
    }
  }

  return events;
}

/** The agent id of a review skill the user typed, which Claude Code runs in the background; null for any other. */
function forkedLaunchOf(content: string): string | null {
  const json = /<forked-skill-launch>(.*?)<\/forked-skill-launch>/su.exec(content)?.[1];

  if (json === undefined) {
    return null;
  }

  try {
    const launch: unknown = JSON.parse(json);

    return isRecord(launch) && REVIEW_SKILLS.has(stringField(launch, "skillName") ?? "")
      ? (stringField(launch, "agentId") ?? null)
      : null;
  } catch {
    return null;
  }
}

function notificationsOf(notice: string, at: number): Event[] {
  return [...notice.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/gu)].flatMap(
    (match) => {
      const body = match[1] ?? "";
      const id = /<task-id>([^<]+)<\/task-id>/u.exec(body)?.[1];

      return id === undefined
        ? []
        : [
            {
              kind: "notified" as const,
              at,
              id,
              status: /<status>([^<]+)<\/status>/u.exec(body)?.[1] ?? "",
              summary: /<summary>([^<]*)<\/summary>/u.exec(body)?.[1] ?? "",
            },
          ];
    },
  );
}

function textOf(blocks: readonly Record<string, unknown>[]): string {
  return blocks.map((block) => stringField(block, "text") ?? "").join("\n");
}

/** The message a `git commit` command writes, as far as its text shows it: a heredoc's body, else `-m`'s value. */
export function messageOf(command: string): string | null {
  const heredoc = /<<-?\s*\\?(['"]?)(\w+)\1[^\n]*\n([\s\S]*?)\n\s*\2\s*(?:\n|$)/u.exec(
    command,
  )?.[3];

  const quoted = /(?:^|\s)-[a-zA-Z]*m\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/u.exec(command);
  const message = heredoc ?? quoted?.[1] ?? quoted?.[2];

  return message === undefined || message.startsWith("$(") ? null : message.trim();
}

/** The position of the last record at or before `time`: where the previous commit stands in the transcript. */
export function positionOf(transcript: Transcript, time: number): number {
  return transcript.times.findLastIndex((recordTime) => recordTime <= time);
}

/**
 * The trigger the facts alone give: `human` when a user message, a subagent's brief or its lead's message arrived
 * since the previous commit, else `self`. A main session whose transcript does not yet hold the turn's prompt counts
 * a prompt other than the previous commit's as a message.
 */
export function factTriggerOf(
  transcript: Transcript,
  mark: CommitMark | null,
  promptId: string | undefined,
  subagent: boolean,
): "human" | "self" {
  const previous = mark === null ? -1 : positionOf(transcript, mark.at);

  if (transcript.events.some((event) => event.kind === "human" && event.at > previous)) {
    return "human";
  }

  return !subagent &&
    promptId !== undefined &&
    !transcript.holdsPrompt &&
    mark?.promptId !== promptId
    ? "human"
    : "self";
}

const FACT_LIMITS = {
  humans: 4,
  says: 6,
  humanChars: 700,
  sayChars: 300,
  blockChars: 300,
  messageChars: 800,
  totalChars: 12_000,
};

/**
 * What the classifier reads about one commit: the facts since the earliest mark the trigger may reach back to, oldest
 * first, then the commit's message. That mark is the older of the previous commit and the last user message, or the
 * later of the commit before that message and the message before it, so a review finished one turn earlier shows.
 */
export function factsOf(
  transcript: Transcript,
  mark: CommitMark | null,
  message: string | null,
  subagent: boolean,
): string {
  const { events } = transcript;
  const previous = mark === null ? -1 : positionOf(transcript, mark.at);
  const humans = events.filter((event) => event.kind === "human");
  const lastHuman = humans.at(-1)?.at ?? -1;
  const humanBefore = humans.filter((event) => event.at < lastHuman).at(-1)?.at ?? -1;

  const commitBefore =
    events.filter((event) => event.kind === "committed" && event.at < lastHuman).at(-1)?.at ?? -1;

  const open = Math.min(previous, Math.max(commitBefore, humanBefore), lastHuman);
  const brief = subagent ? humans.find((event) => event.source === "brief") : undefined;
  const shown = events.filter((event) => event.at > open || event === brief);
  const says = new Set(shown.filter((event) => event.kind === "say").slice(-FACT_LIMITS.says));
  const kept = new Set(shown.filter((event) => event.kind === "human").slice(-FACT_LIMITS.humans));
  const launched = new Set(events.flatMap((event) => (event.kind === "launch" ? [event.id] : [])));

  const lines = shown.flatMap((event) => {
    const when = event.at <= previous ? " (before the previous commit)" : "";

    switch (event.kind) {
      case "human": {
        const label =
          event.source === "lead"
            ? "message from the lead agent"
            : event.source === "brief"
              ? "the agent's brief"
              : "user message";

        return kept.has(event) || event === brief
          ? [`[${label}${when}] ${clip(event.text, FACT_LIMITS.humanChars)}`]
          : [];
      }

      case "notified": {
        return event.status === "completed" && launched.has(event.id)
          ? [`[review finished${when}] ${event.summary}`]
          : [];
      }

      case "reviewed": {
        return [`[review finished${when}] ${event.what}`];
      }

      case "blocked": {
        return [
          `[a ${event.hook} hook blocked the end of the turn${when}] ${clip(event.text, FACT_LIMITS.blockChars)}`,
        ];
      }

      case "committed": {
        return [`[the agent committed${when}] ${event.subject ?? "(subject not shown)"}`];
      }

      case "say": {
        return says.has(event) ? [`[agent${when}] ${clip(event.text, FACT_LIMITS.sayChars)}`] : [];
      }

      case "launch": {
        return [];
      }

      default: {
        const unreachable: never = event;
        throw new Error(`unhandled event: ${JSON.stringify(unreachable)}`);
      }
    }
  });

  const facts = lines.join("\n\n");
  const commit = `[THE COMMIT TO CLASSIFY] ${message === null ? "(message not shown in the command)" : clip(message, FACT_LIMITS.messageChars)}`;
  const room = FACT_LIMITS.totalChars - commit.length - "…\n\n".length;

  return `${facts.length > room ? `…${facts.slice(-room)}` : facts}\n\n${commit}`;
}

function clip(text: string, chars: number): string {
  return (text.length > chars ? `${text.slice(0, chars)}…` : text)
    .replaceAll(/\n{3,}/gu, "\n\n")
    .trim();
}

/** The instructions the trigger was measured with: changing them invalidates the measurement (see SKILL.md). */
export const CLASSIFIER_PROMPT = `You classify what triggered a coding agent's git commit, from facts extracted from the agent's own transcript. Answer with the one trigger that caused this commit:
- "review": the commit applies findings of a review of the work: a /code-review, a reviewer agent, an audit whose findings the agent is applying, a verification by another agent or session, or review findings the user pasted or relayed (for example "arbitrate and fix", "apply the findings"). Every commit of a series that applies the same review's findings is "review", even after the user says "go".
- "stop-hook": the commit fixes what a Stop or SubagentStop hook reported when it blocked the end of a turn (lint, format, failing checks). A block about something else does not make the commit "stop-hook".
- "human": the commit does what a user message asked for or answers a user remark (a request, a correction, a choice between options, "commit", "go"). For a subagent, its brief and messages from its lead agent count as user messages.
- "self": the agent continues on its own: the next step of its plan or brief after earlier commits, a bug it found itself, a failing test, CI or pre-commit check, bookkeeping (progress log, version bump) of work already committed.
A review, block or message that came before the previous commit and was already acted on there does not cause this commit, unless this commit continues applying it. Facts are listed oldest first.
Answer with one JSON object and nothing else: {"trigger": "review" | "stop-hook" | "human" | "self", "reason": "<one sentence>"}.`;

/** Leaves the classifier that much time to exit once killed, and the hook that much to encode its answer. */
const CLASSIFIER_MARGIN_MS = 2000;

/** Haiku's answer on whether the commit applies a review, or why it gave none. */
export type Classification =
  | { readonly kind: "answered"; readonly review: boolean }
  | { readonly kind: "failed"; readonly why: string };

/**
 * Asks Haiku, headless, with no tool, no hook, no MCP server and no saved session, what triggered the commit. Only
 * its `review` is kept: the facts decide between `human` and `self` better than it does.
 */
export async function classify(
  facts: string,
  deadline: Deadline,
  runner: Runner,
): Promise<Classification> {
  const timeoutMs = deadline.remaining() - CLASSIFIER_MARGIN_MS;

  if (timeoutMs <= 0) {
    return { kind: "failed", why: "no time left before the hook's deadline" };
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
      CLASSIFIER_PROMPT,
      facts,
    ],
    { cwd: tmpdir(), timeoutMs },
  );

  switch (result.kind) {
    case "missing": {
      return { kind: "failed", why: "claude is not on PATH" };
    }

    case "timedOut": {
      return { kind: "failed", why: `no answer within ${result.timeoutMs} ms` };
    }

    case "exited": {
      const trigger = result.code === 0 ? triggerIn(result.stdout) : null;

      return trigger === null
        ? { kind: "failed", why: `claude -p exited ${result.code} with no trigger` }
        : { kind: "answered", review: trigger === "review" };
    }

    default: {
      const unreachable: never = result;
      throw new Error(`unhandled run: ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * The trigger in `claude -p --output-format json`'s output: its result message, alone or the last of the array the
 * user's `verbose` setting prints, holds Haiku's JSON object.
 */
function triggerIn(stdout: string): string | null {
  try {
    const output: unknown = JSON.parse(stdout);

    const message = Array.isArray(output)
      ? output.findLast((item) => isRecord(item) && item["type"] === "result")
      : output;

    const result = isRecord(message) ? stringField(message, "result") : undefined;
    const answer: unknown = JSON.parse(/\{[\s\S]*\}/u.exec(result ?? "")?.[0] ?? "null");

    return isRecord(answer) ? (stringField(answer, "trigger") ?? null) : null;
  } catch {
    return null;
  }
}

const TRAILER_KEYS = ["Agent-Trigger", "Agent-Session"] as const;

/** The `--trailer` options inserted after `commit`, each value quoted for Bash. */
export function trailersOf(values: readonly (readonly [string, string])[]): string {
  return values.map(([key, value]) => ` --trailer ${shellQuote(`${key}: ${value}`)}`).join("");
}

export function provenanceTrailers(trigger: Trigger, session: string): [string, string][] {
  return [
    [TRAILER_KEYS[0], trigger],
    [TRAILER_KEYS[1], session],
  ];
}

/** The `Agent-*` trailers of a commit message as `git log --format=%(trailers:only,unfold)` prints them. */
export function agentTrailersIn(trailers: string): [string, string][] {
  return trailers.split("\n").flatMap((line): [string, string][] => {
    const [, key, value] = /^(Agent-[\w-]+):\s*(.*)$/u.exec(line.trim()) ?? [];

    return key === undefined || value === undefined ? [] : [[key, value]];
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** How a `git commit` treats its message: a new commit, an amend that writes a new one, or one that keeps it. */
export type CommitForm = "new" | "amend" | "kept";

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

/**
 * The form of a `git commit` from its arguments. An amend keeps its message unless `-m` or `-F` writes a new one;
 * a dry run commits nothing.
 */
export function commitFormOf(args: readonly string[]): CommitForm {
  let amend = false;
  let message = false;
  let dryRun = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";

    if (arg === "--") {
      break;
    }

    if (arg.startsWith("--")) {
      const name = arg.split("=")[0] ?? arg;
      amend ||= name === "--amend";
      dryRun ||= name === "--dry-run";
      message ||= name === "--message" || name === "--file";
      index += !arg.includes("=") && VALUE_OPTIONS.has(name) ? 1 : 0;
    } else if (arg.startsWith("-") && arg.length > 1) {
      const letters = arg.slice(1).split("");
      const valueAt = letters.findIndex((letter) => SHORT_VALUE_OPTIONS.has(letter));
      const letter = letters[valueAt];
      message ||= letter === "m" || letter === "F";
      index += valueAt !== -1 && valueAt === letters.length - 1 ? 1 : 0;
    }
  }

  if (dryRun) {
    return "kept";
  }

  return amend ? (message ? "amend" : "kept") : "new";
}
