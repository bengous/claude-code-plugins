#!/usr/bin/env bun

/**
 * Pick the commits to read in a weekly sampled review, so a human (or an agent
 * asked to) reviews a few landed commits a week instead of every one.
 *
 *   bun ./scripts/sample-review.ts [--week <YYYY-Www>] [--count <n>] [--ref <ref>]
 *
 * A picker, not a reviewer: it prints each commit with the `/code-review`
 * invocation that reviews it, and the session that produced it when the
 * commit's pull request names one. It reads `--ref` (default `origin/dev`) as
 * it is; `git fetch origin` first for a current sample.
 *
 * The candidates are the non-merge commits whose committer date falls in an
 * ISO week, Monday 00:00 UTC to the next (the last complete one, or the one
 * `--week` names), minus the version bumps (`chore(<scope>): x.y.z`) and the commits with no code in them
 * (documentation, lockfiles). Each candidate draws an exponential clock from a
 * hash of the week and its sha, divided by the square root of its code lines;
 * the `--count` smallest clocks are the sample. That is weighted sampling
 * without replacement, with nothing random in it: the same week and the same
 * commits give the same sample whatever their order, and a commit joining or
 * leaving the pool changes the sample only if it is, or outdraws, a pick.
 */

import { createHash } from "node:crypto";
import { parseArgs } from "node:util";

const DEFAULT_COUNT = 3;

const DEFAULT_REF = "origin/dev";

const USAGE =
  "Usage: bun ./scripts/sample-review.ts [--week <YYYY-Www>] [--count <n>] [--ref <ref>]";

const DAY_MS = 86_400_000;

const WEEK_TEXT = /^(\d{4})-W(\d{2})$/u;

export const VERSION_BUMP = /^chore(?:\([^)]*\))?: \d+\.\d+\.\d+(?:[\s,]|$)/u;

const LOCKFILE = /(?:^|\/)(?:[^/]*\.lock|package-lock\.json|bun\.lockb)$/u;

const MARKDOWN = /\.mdx?$/u;

// Markdown a session or a hook reads as instructions, not as prose about the code.
const BEHAVIOUR = /(?:^|\/)(?:skills|agents|commands|\.claude)\/|\.prompt\.md$/u;

const NUMSTAT = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/u;

const SESSION_LINE = /<!-- opened_by: (\S+) -->/u;

const RECORD = "\u001E";

const FIELD = "\u001F";

/** An ISO 8601 week, `YYYY-Www`, that exists. */
export type IsoWeek = string & { readonly __brand: "IsoWeek" };

/** An ISO week as the instants it spans, `from` included to `to` excluded. */
export interface Period {
  readonly week: IsoWeek;
  readonly from: Date;
  readonly to: Date;
}

export interface FileChange {
  readonly path: string;
  readonly added: number;
  readonly deleted: number;
}

export interface Commit {
  readonly sha: string;
  readonly subject: string;
  readonly landed: Date;
  readonly files: readonly FileChange[];
}

export interface Sample {
  readonly ref: string;
  readonly head: string;
  readonly period: Period;
  readonly landed: number;
  readonly eligible: number;
  readonly picked: readonly Commit[];
}

/** What asking `gh` for the session behind a commit gave. */
export type SessionLookup =
  | { readonly kind: "found"; readonly session: string }
  | { readonly kind: "none" }
  | { readonly kind: "failed"; readonly why: string };

type Cli =
  | {
      readonly kind: "run";
      readonly week: IsoWeek | null;
      readonly count: number;
      readonly ref: string;
    }
  | { readonly kind: "usage"; readonly why: string };

function mondayOf(year: number, week: number): number {
  const januaryFourth = new Date(Date.UTC(year, 0, 4));
  const weekdayOfFourth = januaryFourth.getUTCDay() || 7;

  return januaryFourth.getTime() - (weekdayOfFourth - 1) * DAY_MS + (week - 1) * 7 * DAY_MS;
}

/** The ISO week a UTC instant falls in. */
export function isoWeekOf(instant: Date): IsoWeek {
  const weekday = instant.getUTCDay() || 7;

  const thursday = Date.UTC(
    instant.getUTCFullYear(),
    instant.getUTCMonth(),
    instant.getUTCDate() + 4 - weekday,
  );

  const year = new Date(thursday).getUTCFullYear();
  const week = Math.floor((thursday - Date.UTC(year, 0, 1)) / DAY_MS / 7) + 1;

  // SAFETY: the brand states an existing ISO week, which this arithmetic yields.
  return `${year}-W${String(week).padStart(2, "0")}` as IsoWeek;
}

/** `text` as an ISO week, null when it is not written `YYYY-Www` or the year has no such week. */
export function parseWeek(text: string): IsoWeek | null {
  const [, year = "", week = ""] = WEEK_TEXT.exec(text) ?? [];

  if (year === "") return null;

  const named = isoWeekOf(new Date(mondayOf(Number(year), Number(week))));

  // SAFETY: the week came back from the calendar as the one the text names.
  return named === text ? (text as IsoWeek) : null;
}

/** An ISO week, Monday 00:00 UTC to the next Monday. */
export function periodOf(week: IsoWeek): Period {
  const [year = "", number = ""] = week.split("-W");
  const from = mondayOf(Number(year), Number(number));

  return { week, from: new Date(from), to: new Date(from + 7 * DAY_MS) };
}

/** The last ISO week that ended before `now`: the week the instant 7 days earlier falls in. */
export function lastCompleteWeek(now: Date): IsoWeek {
  return isoWeekOf(new Date(now.getTime() - 7 * DAY_MS));
}

function isDocumentation(path: string): boolean {
  return MARKDOWN.test(path) && !BEHAVIOUR.test(path);
}

function isCode(path: string): boolean {
  return !isDocumentation(path) && !LOCKFILE.test(path);
}

function codeLines(commit: Commit): number {
  return commit.files
    .filter((file) => isCode(file.path))
    .reduce((total, file) => total + file.added + file.deleted, 0);
}

/** A commit worth reading: not a version bump, and with code in it. */
export function isEligible(commit: Commit): boolean {
  return !VERSION_BUMP.test(commit.subject) && commit.files.some((file) => isCode(file.path));
}

/** How much a commit pulls on the draw: the square root of its code lines, at least 1. */
export function weightOf(commit: Commit): number {
  return Math.sqrt(Math.max(1, codeLines(commit)));
}

// A uniform number in (0, 1) from the first 48 bits of a SHA-256, a hash whose output no Bun release changes.
function unitOf(week: IsoWeek, sha: string): number {
  const digest = createHash("sha256").update(`${week}\0${sha}`).digest();

  return (digest.readUIntBE(0, 6) + 0.5) / 2 ** 48;
}

function bySha(a: Commit, b: Commit): number {
  return a.sha < b.sha ? -1 : 1;
}

/** The `count` commits `week` draws from `commits`, oldest first. */
export function pick(commits: readonly Commit[], week: IsoWeek, count: number): readonly Commit[] {
  return commits
    .map((commit) => ({ commit, clock: -Math.log(unitOf(week, commit.sha)) / weightOf(commit) }))
    .toSorted((a, b) => a.clock - b.clock || bySha(a.commit, b.commit))
    .slice(0, count)
    .map(({ commit }) => commit)
    .toSorted((a, b) => a.landed.getTime() - b.landed.getTime() || bySha(a, b));
}

/** The session a pull request body names as its opener, null without the line. */
export function sessionOf(body: string): string | null {
  return SESSION_LINE.exec(body)?.[1] ?? null;
}

function git(cwd: string, args: readonly string[], input = ""): string {
  const result = Bun.spawnSync(["git", "-c", "core.quotePath=false", "-C", cwd, ...args], {
    stdin: Buffer.from(input),
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString().trim()}`);
  }

  return result.stdout.toString();
}

function countOf(text: string): number {
  return text === "-" ? 0 : Number(text);
}

// `git log -z --numstat`: a record is `\x1e<sha>` then one token per file, `<added>\t<deleted>\t<path>`,
// or `<added>\t<deleted>\t` followed by the old and the new path of a rename.
function filesByCommit(log: string): ReadonlyMap<string, readonly FileChange[]> {
  const files = new Map<string, FileChange[]>();
  const tokens = log.split("\0");
  let current: FileChange[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";

    if (token.startsWith(RECORD)) {
      current = [];
      files.set(token.slice(RECORD.length), current);
      continue;
    }

    const [, added = "", deleted = "", path = ""] = NUMSTAT.exec(token.replace(/^\n/u, "")) ?? [];

    if (added === "") continue;

    if (path === "") {
      current.push({
        path: tokens[index + 2] ?? "",
        added: countOf(added),
        deleted: countOf(deleted),
      });
      index += 2;
    } else {
      current.push({ path, added: countOf(added), deleted: countOf(deleted) });
    }
  }

  return files;
}

/** The non-merge commits of `ref` whose committer date falls in `period`, with the files they changed. */
export function landedIn(cwd: string, ref: string, period: Period): readonly Commit[] {
  const dated = git(cwd, [
    "log",
    "--no-merges",
    `--format=%H${FIELD}%cI${FIELD}%s`,
    "--end-of-options",
    ref,
  ])
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [sha = "", date = "", subject = ""] = line.split(FIELD);

      return { sha, subject, landed: new Date(date) };
    })
    .filter(({ landed }) => landed >= period.from && landed < period.to);

  if (dated.length === 0) return [];

  const files = filesByCommit(
    git(
      cwd,
      ["log", "--stdin", "--no-walk=unsorted", "-z", "--numstat", `--format=${RECORD}%H`],
      dated.map(({ sha }) => sha).join("\n"),
    ),
  );

  return dated.map((commit) => ({ ...commit, files: files.get(commit.sha) ?? [] }));
}

/** What `ref` landed in `period`, and the `count` of it worth reading. */
export function sample(cwd: string, ref: string, period: Period, count: number): Sample {
  const landed = landedIn(cwd, ref, period);
  const eligible = landed.filter((commit) => isEligible(commit));

  return {
    ref,
    head: git(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]).trim(),
    period,
    landed: landed.length,
    eligible: eligible.length,
    picked: pick(eligible, period.week, count),
  };
}

/** Asks `gh` for the pull request that carried `sha`, and the session its body names. */
export function lookupSession(cwd: string, sha: string): SessionLookup {
  let result: Bun.SyncSubprocess<"pipe", "pipe">;

  try {
    result = Bun.spawnSync(
      ["gh", "pr", "list", "--state", "all", "--search", sha, "--json", "body"],
      {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
  } catch (error) {
    return { kind: "failed", why: error instanceof Error ? error.message : String(error) };
  }

  if (result.exitCode !== 0) {
    return { kind: "failed", why: result.stderr.toString().trim().split("\n")[0] ?? "" };
  }

  let pulls: readonly { readonly body: string }[];

  try {
    // SAFETY: gh prints one object per pull request with the one field asked for, a string.
    pulls = JSON.parse(result.stdout.toString());
  } catch {
    return { kind: "failed", why: `gh printed no JSON: ${result.stdout.toString().slice(0, 80)}` };
  }

  for (const { body } of pulls) {
    const session = sessionOf(body);

    if (session !== null) return { kind: "found", session };
  }

  return { kind: "none" };
}

function stamp(date: Date): string {
  return `${date.toISOString().slice(0, 16)}Z`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function describe(commit: Commit): string {
  const added = commit.files.reduce((total, file) => total + file.added, 0);
  const deleted = commit.files.reduce((total, file) => total + file.deleted, 0);

  return `${plural(commit.files.length, "file")}, +${added} -${deleted}`;
}

/** The report: the sample with a review invocation per commit, a session line where `sessions` has one, and a note. */
export function render(
  found: Sample,
  sessions: ReadonlyMap<string, string>,
  note: string | null,
): string {
  const { period } = found;
  const span = `${stamp(period.from)}..${stamp(period.to)}`;
  const where = `${found.landed} landed on ${found.ref} (${found.head.slice(0, 8)}), ${span}`;

  if (found.picked.length === 0) return `no commit to sample: ${period.week}, ${where}`;

  const lines = [
    `sample-review ${period.week}: ${found.picked.length} of ${found.eligible} eligible commits, ${where}`,
  ];

  for (const [index, commit] of found.picked.entries()) {
    const session = sessions.get(commit.sha);

    lines.push(
      "",
      `${index + 1}. ${commit.sha.slice(0, 8)}  ${commit.subject}`,
      `   ${describe(commit)}`,
      `   /code-review ${commit.sha}^..${commit.sha}`,
      ...(session === undefined
        ? []
        : [`   session: claude --resume ${session}, then /hindsight debrief`]),
    );
  }

  return [...lines, ...(note === null ? [] : ["", note])].join("\n");
}

function parseCli(argv: readonly string[]): Cli {
  let values: { week?: string | undefined; count?: string | undefined; ref?: string | undefined };

  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        week: { type: "string" },
        count: { type: "string" },
        ref: { type: "string" },
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

  const countText = values.count ?? String(DEFAULT_COUNT);

  if (!/^[1-9]\d*$/u.test(countText)) {
    return { kind: "usage", why: `--count ${countText} is not a positive integer` };
  }

  return { kind: "run", week, count: Number(countText), ref: values.ref ?? DEFAULT_REF };
}

function main(argv: readonly string[]): number {
  const cli = parseCli(argv);

  if (cli.kind === "usage") {
    console.error(`${cli.why}\n${USAGE}`);

    return 2;
  }

  const cwd = process.cwd();
  const period = periodOf(cli.week ?? lastCompleteWeek(new Date()));
  let found: Sample;

  try {
    found = sample(cwd, cli.ref, period, cli.count);
  } catch (error) {
    console.error(`sample-review: ${error instanceof Error ? error.message : String(error)}`);

    return 1;
  }

  const sessions = new Map<string, string>();
  let note: string | null = null;

  for (const commit of found.picked) {
    const lookup = lookupSession(cwd, commit.sha);

    if (lookup.kind === "found") sessions.set(commit.sha, lookup.session);

    if (lookup.kind === "failed") {
      note = `session lookup failed: ${lookup.why}`;
      break;
    }
  }

  console.log(render(found, sessions, note));

  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
