#!/usr/bin/env bun

/**
 * Count the frictions of the agent workflow over one ISO week, next to the
 * friction audit's weekly average, so a change meant to remove one is judged
 * by a number.
 *
 *   bun ./scripts/friction-report.ts [--week <YYYY-Www>] [--ref <ref>]
 *     [--projects-dir <dir>] [--denial-log <file>]
 *
 * Local only: it reads the Claude Code transcripts of every project directory
 * whose name holds `claude-code-plugins` (`--projects-dir`, default
 * `~/.claude/projects`, subagents included) and the auto-mode denial log
 * (`--denial-log`, default `~/.local/state/claude/permission-denied.jsonl`),
 * which CI has neither of. It reads `--ref` (default `origin/dev`) as it is,
 * so `git fetch origin` first, and asks `gh` for the `flaky` issues.
 *
 * An event counts in the week its own timestamp falls in, Monday 00:00 UTC to
 * the next (the last complete week, or the one `--week` names), whatever file
 * holds it; an event copied into a second transcript counts once.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import {
  type IsoWeek,
  landedIn,
  lastCompleteWeek,
  type Period,
  parseWeek,
  periodOf,
  VERSION_BUMP,
} from "./sample-review.ts";

const DEFAULT_REF = "origin/dev";

const USAGE =
  "Usage: bun ./scripts/friction-report.ts [--week <YYYY-Www>] [--ref <ref>] [--projects-dir <dir>] [--denial-log <file>]";

const PROJECT = "claude-code-plugins";

const RELEASE_REFUSAL = "Bump each version in its plugin.json";

const PUSH_FAILED = /failed to push some refs to '[^']*bengous\/claude-code-plugins/u;

const AGENT_MESSAGES = [
  "<task-notification>",
  "<teammate-message",
  "<agent-message",
  "Another Claude session sent a message:",
] as const;

const CI_WAIT =
  /gh run watch|gh pr checks[^|;&]*--watch|(?:until|while)[^;]*gh (?:run|pr|api)|gh (?:run|pr|api).{0,300}sleep|sleep.{0,200}gh (?:run|pr|api)/su;

const GIT_PUSH = /\bgit(?:\s+-C\s+\S+)?\s+push\b/u;

const TYPED = /^<bash-input>([\s\S]*?)<\/bash-input>/u;

const TYPED_RELEASE = /release-plugins|scripts\/release\.ts/u;

const TYPED_DESTRUCTIVE = /branch -D|push .*--delete|--force|push origin \S+:dev|gh stack merge/u;

const ISOLATION_REFUSAL =
  /isolated in the worktree|too complex to verify|isolation context for this agent was lost/u;

const REVIEW_FOLLOW_UP = /review of #|review.s findings|second review|answers the review/u;

const HOUR_MS = 3_600_000;

/**
 * The friction audit, counted by hand from git, GitHub and the transcripts
 * over 21 September to 19 October 2026, both days included: its fourth
 * release refusal fell on the 19th. Agent CI waiting is the foreground time.
 */
export const BASELINE = {
  from: "2026-09-21",
  through: "2026-10-19",
  days: 29,
  totals: {
    releaseRefusals: 4,
    ciWaitCalls: 490,
    ciWaitHours: 9.18,
    typedReleases: 11,
    typedDestructive: 17,
    isolationRefusals: 329,
    reviewFollowUps: 74,
    versionBumps: 64,
  },
} as const;

/** What a transcript line says that a counter reads. */
export type TranscriptEvent =
  | {
      readonly kind: "call";
      readonly id: string;
      readonly at: Date;
      readonly command: string;
      readonly background: boolean;
    }
  | {
      readonly kind: "result";
      readonly id: string;
      readonly at: Date;
      readonly text: string;
      readonly isError: boolean;
    }
  | { readonly kind: "said"; readonly at: Date; readonly session: string; readonly text: string };

type Call = Extract<TranscriptEvent, { readonly kind: "call" }>;

export interface ParsedLine {
  readonly uuid: string | null;
  readonly events: readonly TranscriptEvent[];
}

export interface Timed {
  readonly calls: number;
  readonly foregroundMs: number;
}

export interface TranscriptCounts {
  readonly releaseRefusals: number;
  readonly ciWaits: Timed;
  readonly pushes: Timed;
  readonly typed: {
    readonly total: number;
    readonly releases: number;
    readonly destructive: number;
  };
  readonly isolationRefusals: number;
}

export interface TranscriptScan {
  readonly files: number;
  readonly unreadable: number;
  readonly counts: TranscriptCounts;
}

export interface Denial {
  readonly at: Date;
  readonly cwd: string;
  readonly reason: string;
}

export interface DenialCounts {
  readonly total: number;
  readonly byReason: readonly (readonly [reason: string, count: number])[];
  readonly unreadable: number;
}

export interface FlakyIssue {
  readonly createdAt: Date;
  readonly comments: readonly Date[];
}

export interface FlakyCounts {
  readonly opened: number;
  readonly commented: number;
}

export interface CommitCounts {
  readonly landed: number;
  readonly reviewFollowUps: number;
  readonly versionBumps: number;
}

export type Lookup<T> =
  | { readonly kind: "found"; readonly value: T }
  | { readonly kind: "failed"; readonly why: string };

export interface Report {
  readonly period: Period;
  readonly ref: string;
  readonly head: string;
  readonly transcripts: TranscriptScan;
  readonly denials: Lookup<DenialCounts>;
  readonly flaky: Lookup<FlakyCounts>;
  readonly commits: CommitCounts;
}

type Cli =
  | {
      readonly kind: "run";
      readonly week: IsoWeek | null;
      readonly ref: string;
      readonly projectsDir: string;
      readonly denialLog: string;
    }
  | { readonly kind: "usage"; readonly why: string };

interface RawBlock {
  readonly type?: string;
  readonly id?: string;
  readonly name?: string;
  readonly input?: { readonly command?: string; readonly run_in_background?: boolean };
  readonly tool_use_id?: string;
  readonly content?: RawContent;
  readonly is_error?: boolean;
  readonly text?: string;
}

type RawContent = string | RawBlock[];

interface RawLine {
  readonly type?: string;
  readonly uuid?: string;
  readonly sessionId?: string;
  readonly timestamp?: string;
  readonly isSidechain?: boolean;
  readonly message?: { readonly content?: RawContent };
}

function dateOf(text: string | undefined): Date | null {
  const date = new Date(text ?? "");

  return Number.isNaN(date.getTime()) ? null : date;
}

function within(at: Date, period: Period): boolean {
  return at >= period.from && at < period.to;
}

function textOf(content: RawContent | undefined): string {
  if (content === undefined) return "";

  if (!Array.isArray(content)) return content;

  return content
    .flatMap((block) => (block.type === "text" && block.text !== undefined ? [block.text] : []))
    .join("\n");
}

function blocksOf(content: RawContent | undefined): readonly RawBlock[] {
  return Array.isArray(content) ? content : [];
}

function callsIn(content: RawContent | undefined, at: Date): readonly TranscriptEvent[] {
  return blocksOf(content).flatMap((block): TranscriptEvent[] => {
    const command = block.input?.command;

    if (block.type !== "tool_use" || block.name !== "Bash") return [];

    if (block.id === undefined || command === undefined) return [];

    return [
      {
        kind: "call",
        id: block.id,
        at,
        command,
        background: block.input?.run_in_background === true,
      },
    ];
  });
}

function resultsIn(content: RawContent | undefined, at: Date): readonly TranscriptEvent[] {
  return blocksOf(content).flatMap((block): TranscriptEvent[] =>
    block.type === "tool_result" && block.tool_use_id !== undefined
      ? [
          {
            kind: "result",
            id: block.tool_use_id,
            at,
            text: textOf(block.content),
            isError: block.is_error === true,
          },
        ]
      : [],
  );
}

/**
 * The events of one transcript line, null when it is not JSON. A Bash call, a
 * tool result, or a main-session user message that is no tool result: what
 * the human typed, pasted, or ran with `!`.
 */
export function parseLine(line: string): ParsedLine | null {
  let value: RawLine | null;

  try {
    // SAFETY: a transcript line is a JSON object of Claude Code's; every field read below is optional and compared, never trusted.
    value = JSON.parse(line);
  } catch {
    return null;
  }

  const uuid = value?.uuid ?? null;
  const at = dateOf(value?.timestamp);
  const content = value?.message?.content;

  if (at === null || content === undefined) return { uuid, events: [] };

  if (value?.type === "assistant") return { uuid, events: callsIn(content, at) };

  if (value?.type !== "user") return { uuid, events: [] };

  const results = resultsIn(content, at);

  if (results.length > 0 || value.isSidechain === true) return { uuid, events: results };

  const text = textOf(content);

  return {
    uuid,
    events: text === "" ? [] : [{ kind: "said", at, session: value.sessionId ?? "", text }],
  };
}

/** A command that waits on CI: `gh run watch`, `gh pr checks --watch`, or a loop or a sleep around `gh run|pr|api`. */
export function isCiWait(command: string): boolean {
  return CI_WAIT.test(command);
}

/** A command that runs `git push`, among whatever else it chains. */
export function isGitPush(command: string): boolean {
  return GIT_PUSH.test(command);
}

/** The command a user message ran with `!`, null when it is no such message. */
export function typedCommandOf(text: string): string | null {
  return TYPED.exec(text)?.[1]?.trim() ?? null;
}

/** A command typed with `!` that releases. */
export function isTypedRelease(command: string): boolean {
  return TYPED_RELEASE.test(command);
}

/** A command typed with `!` that deletes or rewrites a branch, or lands without the scripts. */
export function isTypedDestructive(command: string): boolean {
  return TYPED_DESTRUCTIVE.test(command);
}

/**
 * Release output the human brought into a session, by `!` or by pasting it,
 * in which the pre-push release guard refused a push to this repository: the
 * guard's message beside git's failed push. A message an agent sent the
 * session does not count, whatever it quotes.
 */
export function isReleaseRefusal(text: string): boolean {
  return (
    !AGENT_MESSAGES.some((prefix) => text.startsWith(prefix)) &&
    text.includes(RELEASE_REFUSAL) &&
    PUSH_FAILED.test(text)
  );
}

/** A tool call Claude Code refused because the session or the agent is isolated in a worktree. */
export function isIsolationRefusal(text: string, isError: boolean): boolean {
  return isError && ISOLATION_REFUSAL.test(text);
}

/** A commit subject that answers a review. */
export function isReviewFollowUp(subject: string): boolean {
  return REVIEW_FOLLOW_UP.test(subject);
}

function timed(calls: readonly Call[], answered: ReadonlyMap<string, number>): Timed {
  let foregroundMs = 0;

  for (const call of calls) {
    const end = call.background ? undefined : answered.get(call.id);

    if (end !== undefined) foregroundMs += end - call.at.getTime();
  }

  return { calls: calls.length, foregroundMs };
}

/**
 * The transcript counters of `period`. A call counts in the week it was made,
 * and its foreground time runs to its result, wherever that falls; a
 * background call counts with no time.
 */
export function countTranscripts(
  events: Iterable<TranscriptEvent>,
  period: Period,
): TranscriptCounts {
  const waits: Call[] = [];
  const pushes: Call[] = [];
  const typed: string[] = [];
  const refused = new Set<string>();
  const answered = new Map<string, number>();
  let isolationRefusals = 0;

  for (const event of events) {
    if (event.kind === "result") {
      answered.set(event.id, event.at.getTime());

      if (within(event.at, period) && isIsolationRefusal(event.text, event.isError)) {
        isolationRefusals += 1;
      }
    } else if (!within(event.at, period)) {
      continue;
    } else if (event.kind === "call") {
      if (isCiWait(event.command)) waits.push(event);

      if (isGitPush(event.command)) pushes.push(event);
    } else {
      const command = typedCommandOf(event.text);

      if (command !== null) typed.push(command);
      else if (isReleaseRefusal(event.text)) refused.add(event.session);
    }
  }

  return {
    releaseRefusals: refused.size,
    ciWaits: timed(waits, answered),
    pushes: timed(pushes, answered),
    typed: {
      total: typed.length,
      releases: typed.filter((command) => isTypedRelease(command)).length,
      destructive: typed.filter((command) => isTypedDestructive(command)).length,
    },
    isolationRefusals,
  };
}

/** The transcripts of this repository's projects under `projectsDir` written to since `since`, subagents included. */
export function transcriptFiles(projectsDir: string, since: Date): readonly string[] {
  return readdirSync(projectsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.includes(PROJECT))
    .flatMap((entry) => {
      const dir = join(projectsDir, entry.name);

      return readdirSync(dir, { recursive: true, encoding: "utf8" })
        .filter((path) => path.endsWith(".jsonl"))
        .map((path) => join(dir, path));
    })
    .filter((file) => statSync(file).mtime >= since)
    .toSorted();
}

/** The transcript counters of `period`, read from `projectsDir`, each event once by its uuid. */
export function scanTranscripts(projectsDir: string, period: Period): TranscriptScan {
  const files = transcriptFiles(projectsDir, period.from);
  const seen = new Set<string>();
  let unreadable = 0;

  function* events(): Generator<TranscriptEvent> {
    for (const file of files) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (line === "") continue;

        const parsed = parseLine(line);

        if (parsed === null) {
          unreadable += 1;
          continue;
        }

        if (parsed.uuid !== null) {
          if (seen.has(parsed.uuid)) continue;

          seen.add(parsed.uuid);
        }

        yield* parsed.events;
      }
    }
  }

  const counts = countTranscripts(events(), period);

  return { files: files.length, unreadable, counts };
}

/** A line of the denial log, null when it does not read as one. */
export function parseDenial(line: string): Denial | null {
  let value: { readonly ts?: string; readonly cwd?: string; readonly reason?: string } | null;

  try {
    // SAFETY: the PermissionDenied hook writes one JSON object a line; each field read below is optional and checked.
    value = JSON.parse(line);
  } catch {
    return null;
  }

  const at = dateOf(value?.ts);
  const cwd = value?.cwd;
  const reason = value?.reason;

  return at === null || cwd === undefined || reason === undefined ? null : { at, cwd, reason };
}

/** The denials of `period` in a checkout of this repository, by reason, the most frequent first. */
export function countDenials(
  denials: readonly Denial[],
  period: Period,
  unreadable: number,
): DenialCounts {
  const byReason = new Map<string, number>();
  let total = 0;

  for (const denial of denials) {
    if (!within(denial.at, period) || !denial.cwd.includes(PROJECT)) continue;

    total += 1;
    byReason.set(denial.reason, (byReason.get(denial.reason) ?? 0) + 1);
  }

  return {
    total,
    byReason: [...byReason].toSorted(([a, left], [b, right]) => right - left || (a < b ? -1 : 1)),
    unreadable,
  };
}

/** The denial counters of `period`, read from `log`; a missing log is named, not counted as zero. */
export function readDenials(log: string, period: Period): Lookup<DenialCounts> {
  if (!existsSync(log)) return { kind: "failed", why: `no denial log at ${log}` };

  const denials: Denial[] = [];
  let unreadable = 0;

  for (const line of readFileSync(log, "utf8").split("\n")) {
    if (line === "") continue;

    const denial = parseDenial(line);

    if (denial === null) unreadable += 1;
    else denials.push(denial);
  }

  return { kind: "found", value: countDenials(denials, period, unreadable) };
}

/** The flaky issues opened in `period`, and the comments posted on any of them in it. */
export function countFlaky(issues: readonly FlakyIssue[], period: Period): FlakyCounts {
  return {
    opened: issues.filter((issue) => within(issue.createdAt, period)).length,
    commented: issues.flatMap((issue) => issue.comments.filter((at) => within(at, period))).length,
  };
}

function flakyIssuesOf(json: string): readonly FlakyIssue[] | null {
  let value: { readonly createdAt?: string; readonly comments?: readonly string[] }[];

  try {
    // SAFETY: the `--jq` filter prints an array of objects with these two fields; each is checked below.
    value = JSON.parse(json);
  } catch {
    return null;
  }

  if (!Array.isArray(value)) return null;

  const issues: FlakyIssue[] = [];

  for (const item of value) {
    const createdAt = dateOf(item.createdAt);
    const comments = (item.comments ?? []).map((at) => dateOf(at));
    const dated = comments.filter((at) => at !== null);

    if (createdAt === null || item.comments === undefined || dated.length < comments.length) {
      return null;
    }

    issues.push({ createdAt, comments: dated });
  }

  return issues;
}

/** Asks `gh` for every issue labelled `flaky`, with when each comment was posted; a missing label is no issue. */
export function lookupFlaky(cwd: string): Lookup<readonly FlakyIssue[]> {
  let result: Bun.SyncSubprocess<"pipe", "pipe">;

  try {
    result = Bun.spawnSync(
      [
        "gh",
        "issue",
        "list",
        "--label",
        "flaky",
        "--state",
        "all",
        "--limit",
        "1000",
        "--json",
        "createdAt,comments",
        "--jq",
        "[.[] | {createdAt, comments: [.comments[].createdAt]}]",
      ],
      { cwd, stdout: "pipe", stderr: "pipe" },
    );
  } catch (error) {
    return { kind: "failed", why: error instanceof Error ? error.message : String(error) };
  }

  if (result.exitCode !== 0) {
    return { kind: "failed", why: result.stderr.toString().trim().split("\n")[0] ?? "" };
  }

  const issues = flakyIssuesOf(result.stdout.toString());

  return issues === null
    ? { kind: "failed", why: `gh printed no issue list: ${result.stdout.toString().slice(0, 80)}` }
    : { kind: "found", value: issues };
}

/** The review follow-ups and the version bumps among the subjects of the commits a week landed. */
export function countCommits(subjects: readonly string[]): CommitCounts {
  return {
    landed: subjects.length,
    reviewFollowUps: subjects.filter((subject) => isReviewFollowUp(subject)).length,
    versionBumps: subjects.filter((subject) => VERSION_BUMP.test(subject)).length,
  };
}

function headOf(cwd: string, ref: string): string {
  const result = Bun.spawnSync(
    ["git", "-C", cwd, "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
    { stdout: "pipe", stderr: "pipe" },
  );

  if (result.exitCode !== 0) {
    throw new Error(`git rev-parse ${ref}: ${result.stderr.toString().trim()}`);
  }

  return result.stdout.toString().trim();
}

function stamp(date: Date): string {
  return `${date.toISOString().slice(0, 16)}Z`;
}

function weekly(total: number, digits = 1): string {
  return ((total * 7) / BASELINE.days).toFixed(digits);
}

function hours(ms: number): string {
  return (ms / HOUR_MS).toFixed(2);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

type Row = readonly [label: string, week: string, baseline: string];

function table(rows: readonly Row[]): readonly string[] {
  const width = Math.max(...rows.map(([label]) => label.length));
  const weekWidth = Math.max(...rows.map(([, week]) => week.length));
  const baselineWidth = Math.max(...rows.map(([, , baseline]) => baseline.length));

  return rows.map(
    ([label, week, baseline]) =>
      `${label.padEnd(width)}  ${week.padStart(weekWidth)}  ${baseline.padStart(baselineWidth)}`,
  );
}

function countOf<T>(lookup: Lookup<T>, read: (value: T) => number): string {
  return lookup.kind === "found" ? String(read(lookup.value)) : "?";
}

function reasonLines(denials: Lookup<DenialCounts>): readonly string[] {
  if (denials.kind === "failed" || denials.value.byReason.length === 0) return [];

  const width = Math.max(...denials.value.byReason.map(([, count]) => String(count).length));

  return [
    "",
    "classifier denials by reason:",
    ...denials.value.byReason.map(
      ([reason, count]) => `  ${String(count).padStart(width)}  ${reason}`,
    ),
  ];
}

function notesOf(report: Report): readonly string[] {
  const { transcripts, denials, flaky } = report;
  const notes: string[] = [];

  if (transcripts.unreadable > 0) {
    notes.push(`transcripts: ${plural(transcripts.unreadable, "line")} left out, not JSON objects`);
  }

  if (denials.kind === "failed") notes.push(`denials: ${denials.why}`);
  else if (denials.value.unreadable > 0) {
    notes.push(`denials: ${plural(denials.value.unreadable, "line")} left out, not denials`);
  }

  if (flaky.kind === "failed") notes.push(`flaky issues: gh failed: ${flaky.why}`);

  return notes;
}

/** The report: the week's counters beside the baseline's average per 7 days, its sources, and what could not be read. */
export function render(report: Report): string {
  const { period, transcripts, commits, denials, flaky } = report;
  const { counts } = transcripts;
  const { totals } = BASELINE;

  const rows: Row[] = [
    ["", "week", "baseline/week"],
    ["release refusals", String(counts.releaseRefusals), weekly(totals.releaseRefusals)],
    ["agent CI waits", String(counts.ciWaits.calls), weekly(totals.ciWaitCalls)],
    ["  foreground hours", hours(counts.ciWaits.foregroundMs), weekly(totals.ciWaitHours, 2)],
    ["agent git pushes", String(counts.pushes.calls), "-"],
    ["  foreground hours", hours(counts.pushes.foregroundMs), "-"],
    ["! commands typed", String(counts.typed.total), "-"],
    ["  releases", String(counts.typed.releases), weekly(totals.typedReleases)],
    ["  destructive git", String(counts.typed.destructive), weekly(totals.typedDestructive)],
    [
      "worktree isolation refusals",
      String(counts.isolationRefusals),
      weekly(totals.isolationRefusals),
    ],
    ["classifier denials", countOf(denials, (value) => value.total), "-"],
    ["flaky issues opened", countOf(flaky, (value) => value.opened), "-"],
    ["flaky issues commented", countOf(flaky, (value) => value.commented), "-"],
    ["review follow-up commits", String(commits.reviewFollowUps), weekly(totals.reviewFollowUps)],
    ["version bump commits", String(commits.versionBumps), weekly(totals.versionBumps)],
  ];

  const notes = notesOf(report);

  return [
    `friction-report ${period.week}: ${stamp(period.from)}..${stamp(period.to)}`,
    `sources: ${plural(transcripts.files, "transcript file")}, ${commits.landed} commits landed on ${report.ref} (${report.head.slice(0, 8)})`,
    `baseline: the friction audit, ${BASELINE.from}..${BASELINE.through} (${BASELINE.days} days), per 7 days`,
    "",
    ...table(rows),
    ...reasonLines(denials),
    ...(notes.length === 0 ? [] : ["", ...notes]),
  ].join("\n");
}

function parseCli(argv: readonly string[]): Cli {
  let values: {
    week?: string | undefined;
    ref?: string | undefined;
    "projects-dir"?: string | undefined;
    "denial-log"?: string | undefined;
  };

  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        week: { type: "string" },
        ref: { type: "string" },
        "projects-dir": { type: "string" },
        "denial-log": { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    return { kind: "usage", why: error instanceof Error ? error.message : String(error) };
  }

  const week = values.week === undefined ? null : parseWeek(values.week);

  if (values.week !== undefined && week === null) {
    return { kind: "usage", why: `--week ${values.week} is not an ISO week written YYYY-Www` };
  }

  return {
    kind: "run",
    week,
    ref: values.ref ?? DEFAULT_REF,
    projectsDir: values["projects-dir"] ?? join(homedir(), ".claude", "projects"),
    denialLog:
      values["denial-log"] ??
      join(homedir(), ".local", "state", "claude", "permission-denied.jsonl"),
  };
}

function main(argv: readonly string[]): number {
  const cli = parseCli(argv);

  if (cli.kind === "usage") {
    console.error(`${cli.why}\n${USAGE}`);

    return 2;
  }

  const cwd = process.cwd();
  const period = periodOf(cli.week ?? lastCompleteWeek(new Date()));
  let report: Omit<Report, "flaky">;

  try {
    report = {
      period,
      ref: cli.ref,
      head: headOf(cwd, cli.ref),
      transcripts: scanTranscripts(cli.projectsDir, period),
      denials: readDenials(cli.denialLog, period),
      commits: countCommits(landedIn(cwd, cli.ref, period).map((commit) => commit.subject)),
    };
  } catch (error) {
    console.error(`friction-report: ${error instanceof Error ? error.message : String(error)}`);

    return 1;
  }

  const issues = lookupFlaky(cwd);

  const flaky: Lookup<FlakyCounts> =
    issues.kind === "found" ? { kind: "found", value: countFlaky(issues.value, period) } : issues;

  console.log(render({ ...report, flaky }));

  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
