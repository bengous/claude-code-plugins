#!/usr/bin/env bun

/**
 * Lands the Renovate pull requests that Renovate does not merge by itself.
 *
 *   bun ./scripts/renovate-agent.ts run             # the SessionStart hook starts it detached, once a day
 *   bun ./scripts/renovate-agent.ts run --dry-run   # print each open pull request's owner; start nothing
 *
 * Renovate merges a non-major update that touches no e2e path and no risky
 * path itself, by branch automerge, once CI is green on its branch
 * (`renovate.json`). Among the open Renovate pull requests against `dev` whose
 * `ci.yml` runs have concluded, one that touches a path of `origin/dev`'s
 * `profile.review.risky` goes to the human: `land.ts` lands it only with a
 * review verdict, which no unattended agent records; so does one whose branch
 * carries a commit neither Renovate's nor the agent's (its `Renovate-Agent`
 * trailer), read with `git log` after the run's fetch. This run owns the
 * others Renovate leaves: a red one, a major (Renovate's `major` label), one
 * whose files touch the e2e paths (`isE2ePath`), and one carrying the agent's
 * repair. A head this run already handled is left until Renovate pushes
 * another.
 *
 * Each owned pull request gets its own worktree, `<main worktree>.wt/
 * renovate/<number>`, at the branch's head fetched again, which must still be
 * the listed one, with the dependencies installed. A red one is handed first
 * to a headless Claude (`scripts/renovate-agent.prompt.md`) that commits the
 * repair, signed with the user's key and marked with the run's trailer; the
 * run pushes the commits, a fast-forward under a lease, and runs its own
 * `land.ts`, which waits for CI, runs the e2e suite when the branch needs it
 * and lands the branch on `dev`. A landing refused because CI is red goes back
 * to the agent, two agent rounds per Renovate update (`updateOf`) in all,
 * across runs. A deferral, land.ts's exit 3 or a step of the run's own failing
 * on the network (`isTransient`), settles no head and drops the worktree, so
 * the next daily run takes it again; the third in a row goes to the human, as
 * any other refusal does. Each end, landed or not, is a line the next session
 * start shows and a desktop notice. The lock, the logs, the handled heads, the
 * rounds spent, the deferrals in a row and the lines not yet shown live in
 * `<git common dir>/renovate-agent/`.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

import { isE2ePath } from "./check-e2e-green.ts";
import { type CiVerdict, ciVerdict, ghCli, GhError } from "./ci-wait.ts";
import { RUN_GUARD as TYPES_RUN_GUARD } from "./claude-code-types.ts";
import { DEFERRED_EXIT, riskyOf } from "./land.ts";
import {
  type ChildSlot,
  command,
  commonDirOf,
  git,
  heldWork,
  type LockPaths,
  notify,
  probeSigning,
  promptFor,
  STOP_SIGNALS,
  takeRunLock,
  worktreesOf,
  writeWhole,
} from "./lib/headless-run.ts";
import { isTransient, TransientError } from "./lib/transient.ts";

export const MAJOR_LABEL = "major";

const RENOVATE_AUTHOR = "app/renovate";

/** The author of Renovate's commits, as `git log` reads them on its branches here. */
export const RENOVATE_EMAIL = "29139614+renovate[bot]@users.noreply.github.com";

const LAND = join(import.meta.dir, "land.ts");

const LAND_VERDICT = /^(?:land: |landed )/u;

const DEV = "dev";

const PROMPT = join(import.meta.dir, "renovate-agent.prompt.md");

const NOTICE = "Renovate agent";

/** Agent rounds per Renovate update, in all, across runs: each one answers a red CI. */
export const AGENT_ROUNDS = 2;

/** Deferred landings in a row, across runs, after which the update goes to the human. */
export const DEFERRALS = 3;

/** The trailer the script has the agent put on each of its commits, its value the run's id. */
export const AGENT_TRAILER = "Renovate-Agent";

const FIELD = "\u001F";

const RECORD = "\u001E";

const CANNOT_REPAIR = /^CANNOT REPAIR:.*$/mu;

/** land.ts's verdict line when CI is red on the head it waited for (`notGreen`): the one refusal an agent can repair. */
const RED_REFUSAL = /^land: CI is red on /u;

const INSTALLS = [
  ["bun", "install", "--frozen-lockfile"],
  ["bun", "install", "--cwd", "vellum", "--frozen-lockfile"],
  ["bun", "install", "--cwd", "pinpoint", "--frozen-lockfile"],
] as const;

/** An open Renovate pull request, as `gh pr list` gives it. */
export interface RenovatePr {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly headRefName: string;
  readonly headRefOid: string;
  readonly labels: readonly string[];
  readonly files: readonly string[];
}

/** A commit of the branch on top of `origin/dev`, as `git log` reads it. */
export interface BranchCommit {
  readonly sha: string;
  readonly email: string;
  /** Its author date and subject: what `git rebase` keeps and Renovate's own rewrite of the branch changes. */
  readonly identity: string;
  /** The value of its `Renovate-Agent` trailer, empty when it has none. */
  readonly agentRun: string;
}

/** Who wrote a commit: Renovate, this script's agent (its trailer), or anyone else, a human. */
export type Writer = "renovate" | "agent" | "human";

export function writerOf(commit: BranchCommit): Writer {
  if (commit.email === RENOVATE_EMAIL) return "renovate";

  return commit.agentRun === "" ? "human" : "agent";
}

export type BranchRead =
  | { readonly kind: "read"; readonly commits: readonly BranchCommit[] }
  | { readonly kind: "unread"; readonly why: string };

/**
 * The Renovate update a branch carries: its newest commit of Renovate's, by author date and subject, not by SHA, so
 * that land.ts's rebase keeps it while an update or a rewrite of Renovate's makes another. Null when Renovate wrote
 * none of the commits.
 */
export function updateOf(commits: readonly BranchCommit[]): string | null {
  return commits.find((commit) => writerOf(commit) === "renovate")?.identity ?? null;
}

/**
 * `repaired`: a commit of the agent's, which land.ts lands. Renovate stops updating a branch someone else committed
 * to; whether its automerge still takes one is not measured.
 */
export type AgentReason = "red" | "major" | "e2e" | "repaired";

export type Classification =
  | { readonly owner: "renovate"; readonly why: string }
  | {
      readonly owner: "agent";
      readonly reasons: readonly AgentReason[];
      readonly update: string;
    }
  | { readonly owner: "human"; readonly why: string }
  | { readonly owner: "wait"; readonly why: string }
  | { readonly owner: "handled"; readonly why: string };

/** Whether a path needs a human review verdict before `land.ts` lands it. */
export type RiskyPath = (path: string) => boolean;

/**
 * How a pull request ended. `heads` are the heads a landed or failed one
 * settles, which the next runs leave alone: the listed head once an agent
 * round or a landing ran, once its agent rounds are spent or once its landing
 * was deferred `DEFERRALS` times in a row, and each head this run pushed. A
 * stopped or deferred one settles none, not even the heads of an agent round
 * it ran: the next daily run takes the pull request again.
 */
export type PrOutcome =
  | {
      readonly kind: "landed";
      readonly pr: RenovatePr;
      readonly verdict: string;
      readonly heads: readonly string[];
    }
  | {
      readonly kind: "failed";
      readonly pr: RenovatePr;
      readonly reason: string;
      readonly log: string;
      readonly worktree: string | null;
      readonly heads: readonly string[];
    }
  | {
      readonly kind: "stopped";
      readonly pr: RenovatePr;
      readonly signal: string;
      readonly log: string;
      readonly worktree: string | null;
    }
  | {
      readonly kind: "deferred";
      readonly pr: RenovatePr;
      readonly verdict: string;
      readonly log: string;
      readonly worktree: string | null;
    }
  | { readonly kind: "human"; readonly pr: RenovatePr; readonly why: string };

export interface StatePaths extends LockPaths {
  readonly dir: string;
  readonly day: string;
  readonly handled: string;
  readonly rounds: string;
  readonly deferrals: string;
  readonly report: string;
  readonly runLog: string;
  readonly spawnLog: string;
}

/** The heads this run already handled, per pull request number. */
export type Handled = Readonly<Record<string, readonly string[]>>;

/** A count per Renovate update (`updateOf`): the agent rounds it had, or its deferrals in a row. */
export type Counts = Readonly<Record<string, number>>;

export function statePaths(commonDir: string): StatePaths {
  const dir = join(commonDir, "renovate-agent");

  return {
    dir,
    lock: join(dir, "run.lock"),
    holder: join(dir, "holder.json"),
    day: join(dir, "day"),
    handled: join(dir, "handled.json"),
    rounds: join(dir, "rounds.json"),
    deferrals: join(dir, "deferrals.json"),
    report: join(dir, "report.jsonl"),
    runLog: join(dir, "run.log"),
    spawnLog: join(dir, "spawn.log"),
  };
}

export function prLogPath(state: StatePaths, number: number): string {
  return join(state.dir, `pr-${number}.log`);
}

function shortSha(sha: string): string {
  return sha.slice(0, 8);
}

/**
 * The verdict of a head's `ci.yml` runs of both events: red when a run of
 * either is red, running while one of either runs, else the pull request
 * runs' verdict, the runs `land.ts` waits for. Renovate reads every check run
 * of the head, a push run's included (`getBranchStatus`).
 */
export function combinedVerdict(pullRequest: CiVerdict, push: CiVerdict): CiVerdict {
  const red = [pullRequest, push].flatMap((verdict) => (verdict.kind === "red" ? verdict.red : []));

  if (red.length > 0) return { kind: "red", red };

  const running = [pullRequest, push].flatMap((verdict) =>
    verdict.kind === "running" ? verdict.running : [],
  );

  if (running.length > 0) return { kind: "running", running };

  return pullRequest;
}

/**
 * Who lands `pr`, given the commits of its branch, its `ci.yml` verdict, the
 * heads already handled and the risky paths. A commit neither Renovate's nor
 * the agent's is a human's change, which nothing unattended lands. Nobody acts
 * before CI concludes: Renovate would not merge a running branch, and
 * `land.ts` refuses a head with no run.
 */
export function classify(
  pr: RenovatePr,
  branch: BranchRead,
  verdict: CiVerdict,
  handled: Handled,
  isRisky: RiskyPath,
): Classification {
  const sha = shortSha(pr.headRefOid);

  if ((handled[String(pr.number)] ?? []).includes(pr.headRefOid)) {
    return { owner: "handled", why: `${sha} was handled by an earlier run; waits for a new head` };
  }

  if (branch.kind === "unread") return { owner: "wait", why: branch.why };

  const human = branch.commits.find((commit) => writerOf(commit) === "human");

  if (human !== undefined) {
    return {
      owner: "human",
      why: `carries ${shortSha(human.sha)}, a commit neither renovate[bot]'s nor the agent's (no ${AGENT_TRAILER} trailer): nothing unattended lands a change nobody reviewed`,
    };
  }

  const update = updateOf(branch.commits);

  if (update === null) {
    return { owner: "human", why: "carries no commit of renovate[bot]'s on top of dev" };
  }

  if (verdict.kind === "running") return { owner: "wait", why: `CI still runs on ${sha}` };

  if (verdict.kind === "none")
    return { owner: "wait", why: `no ci.yml pull_request run on ${sha}` };

  const risky = pr.files.filter((path) => isRisky(path));

  if (risky.length > 0) {
    return {
      owner: "human",
      why: `touches risky paths (${risky.join(", ")}): land.ts lands it only with a human review verdict`,
    };
  }

  const reasons: AgentReason[] = [];

  if (verdict.kind === "red") reasons.push("red");

  if (pr.labels.includes(MAJOR_LABEL)) reasons.push("major");

  if (pr.files.some((path) => isE2ePath(path))) reasons.push("e2e");

  if (branch.commits.some((commit) => writerOf(commit) === "agent")) reasons.push("repaired");

  if (reasons.length > 0) return { owner: "agent", reasons, update };

  return {
    owner: "renovate",
    why: `green on ${sha}, not major, no e2e path, Renovate's commits alone: Renovate's branch automerge lands it`,
  };
}

export function classificationLine(pr: RenovatePr, classification: Classification): string {
  const head = `#${pr.number} ${pr.headRefName}`;

  if (classification.owner === "agent") {
    return `${head}: agent (${classification.reasons.join(", ")})`;
  }

  return `${head}: ${classification.owner}, ${classification.why}`;
}

export function outcomeLine(outcome: PrOutcome): string {
  const head = `Renovate #${outcome.pr.number} (${outcome.pr.title})`;

  switch (outcome.kind) {
    case "landed":
      return `${head}: ${outcome.verdict}`;
    case "human":
      return `${head} needs your review: it ${outcome.why}. ${outcome.pr.url}`;
    case "stopped":
      return `${head}: the run was stopped by ${outcome.signal} (log: ${outcome.log}${keptNote(outcome.worktree)}); the next daily run takes it again`;
    case "deferred":
      return `${head}: deferred, ${outcome.verdict} (log: ${outcome.log}${keptNote(outcome.worktree)}); the next daily run takes it again`;
    case "failed":
      return `${head} needs you: ${outcome.reason} (log: ${outcome.log}${keptNote(outcome.worktree)}). ${outcome.pr.url}`;
  }
}

function keptNote(worktree: string | null): string {
  return worktree === null ? "" : `; its worktree, ${worktree}, is kept as it is`;
}

/** The pull requests' handled heads plus `added`, restricted to the pull requests still open. */
export function recordHandled(
  handled: Handled,
  open: readonly number[],
  added: Readonly<Record<string, readonly string[]>>,
): Handled {
  return Object.fromEntries(
    open.flatMap((number) => {
      const key = String(number);
      const heads = [...new Set([...(handled[key] ?? []), ...(added[key] ?? [])])];

      return heads.length === 0 ? [] : [[key, heads]];
    }),
  );
}

/** The counts of the updates the open pull requests still carry. */
export function openCounts(counts: Counts, updates: readonly string[]): Counts {
  return Object.fromEntries(
    updates.flatMap((update) => {
      const count = counts[update];

      return count === undefined ? [] : [[update, count]];
    }),
  );
}

/** The commits of `log`, as `git log --format=COMMIT_FORMAT` printed them. */
export function parseCommits(log: string): readonly BranchCommit[] {
  return log
    .split(RECORD)
    .map((record) => record.replace(/^\n/u, ""))
    .filter((record) => record !== "")
    .map((record) => {
      const [sha = "", email = "", date = "", subject = "", agentRun = ""] = record.split(FIELD);

      return { sha, email, identity: `${date} ${subject}`, agentRun: agentRun.trim() };
    });
}

const COMMIT_FORMAT = `--format=%H${FIELD}%ae${FIELD}%aI${FIELD}%s${FIELD}%(trailers:key=${AGENT_TRAILER},valueonly,separator=%x2C)${RECORD}`;

/** The commits `range` holds, read with `git log` from `cwd`. */
function commitsIn(cwd: string, range: string): BranchRead {
  const log = command(["git", "log", COMMIT_FORMAT, range], cwd);

  if (log.code !== 0) return { kind: "unread", why: `git log ${range}: ${log.err.trim()}` };

  return { kind: "read", commits: parseCommits(log.out) };
}

/** The line land.ts ends on, `landed …` or `land: …`, wherever git's own lines after it fall. */
export function landVerdict(output: string): string {
  return output.split("\n").findLast((line) => LAND_VERDICT.test(line)) ?? lastNonEmptyLine(output);
}

interface ListedPr {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  headRefOid: string;
  labels: { name: string }[];
  files: { path: string }[] | null;
}

/** The open Renovate pull requests against `dev`, read with `gh` from `cwd`. */
export function parsePrList(listed: string): readonly RenovatePr[] {
  // SAFETY: the shape `--json number,title,url,headRefName,headRefOid,labels,files` asks gh for.
  return (JSON.parse(listed) as ListedPr[]).map((pr) => ({
    number: pr.number,
    title: pr.title,
    url: pr.url,
    headRefName: pr.headRefName,
    headRefOid: pr.headRefOid,
    labels: pr.labels.map((label) => label.name),
    files: (pr.files ?? []).map((file) => file.path),
  }));
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a catch clause's value is unknown by the language; this function is where it is narrowed.
function isTransientError(error: unknown): boolean {
  return error instanceof TransientError || (error instanceof GhError && error.transient);
}

/** `command`'s output, or the failure it ended on: transient when its output reads as the network's or GitHub's. */
function checked(args: readonly string[], cwd: string): string {
  const result = command(args, cwd);

  if (result.code === 0) return result.out;

  const why = `${args.slice(0, 3).join(" ")} exited ${result.code}: ${`${result.err}${result.out}`.trim()}`;

  throw isTransient(`${result.err}${result.out}`) ? new TransientError(why) : new Error(why);
}

function listPrs(cwd: string): readonly RenovatePr[] {
  return parsePrList(
    checked(
      [
        "gh",
        "pr",
        "list",
        "--author",
        RENOVATE_AUTHOR,
        "--base",
        DEV,
        "--state",
        "open",
        "--limit",
        "100",
        "--json",
        "number,title,url,headRefName,headRefOid,labels,files",
      ],
      cwd,
    ),
  );
}

function readHandled(file: string): Handled {
  // SAFETY: only this run writes the file, whole, from a Handled.
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Handled) : {};
}

function readCounts(file: string): Counts {
  // SAFETY: only this run writes the file, whole, from a Counts.
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Counts) : {};
}

/** Sets the count of `update` in `file` to what `next` makes of it; answers the new count. */
function recount(file: string, update: string, next: (count: number) => number): number {
  const counts = readCounts(file);
  const count = next(counts[update] ?? 0);

  writeWhole(file, JSON.stringify({ ...counts, [update]: count }));

  return count;
}

/**
 * Adds `line` to those the next session start shows, one JSON string per line:
 * an append, so a hook that takes the file meanwhile never sees a line twice.
 */
function report(file: string, line: string): void {
  appendFileSync(file, `${JSON.stringify(line)}\n`);
}

/** The lines of a report file, as `report` wrote them. */
export function reportLines(content: string): string[] {
  return content
    .split("\n")
    .filter((line) => line !== "")
    .map((line): string => JSON.parse(line));
}

interface Progress extends ChildSlot {
  signal: NodeJS.Signals | null;
}

interface Run {
  /** The value of the trailer each of its agent's commits carries. */
  readonly id: string;
  readonly main: string;
  readonly state: StatePaths;
  readonly progress: Progress;
}

function checkStop(progress: Progress): void {
  if (progress.signal !== null) throw new Error(`stopped by ${progress.signal}`);
}

/** Runs a command with its output streamed to the log; answers its exit code and its whole output. */
async function streamed(
  args: readonly string[],
  cwd: string,
  log: number,
  progress: Progress,
  env: Record<string, string> = {},
): Promise<{ code: number; output: string }> {
  checkStop(progress);
  writeSync(log, `== ${args.slice(0, 3).join(" ")}\n`);

  const child = Bun.spawn([...args], {
    cwd,
    env: { ...process.env, ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  progress.child = child;
  let output = "";

  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();

    for await (const chunk of stream) {
      writeSync(log, chunk);
      output += decoder.decode(chunk, { stream: true });
    }
  };

  try {
    const [code] = await Promise.all([child.exited, drain(child.stdout), drain(child.stderr)]);

    return { code, output };
  } finally {
    progress.child = null;
  }
}

function lastNonEmptyLine(text: string): string {
  return (
    text
      .trimEnd()
      .split("\n")
      .findLast((line) => line.trim() !== "") ?? ""
  );
}

/**
 * A fresh worktree on the pull request's branch, at its head fetched now: the
 * run-start fetch may be stale, and a branch Renovate moved since the listing
 * is a head nobody classified.
 */
async function prepareWorktree(run: Run, pr: RenovatePr, path: string): Promise<void> {
  const { checkouts } = await worktreesOf(run.main);
  const holder = checkouts.find((tree) => tree.branch === pr.headRefName && tree.dir !== path);

  if (holder !== undefined) {
    throw new Error(
      `${pr.headRefName} is checked out in ${holder.dir}; the run needs it in ${path}`,
    );
  }

  const ref = `refs/remotes/origin/${pr.headRefName}`;
  checked(["git", "fetch", "--quiet", "origin", `+refs/heads/${pr.headRefName}:${ref}`], run.main);
  const fetched = git(run.main, "rev-parse", ref);

  if (fetched !== pr.headRefOid) {
    throw new Error(
      `${pr.headRefName} is at ${shortSha(fetched)} on origin, not ${shortSha(pr.headRefOid)} as listed: Renovate moved it; the next run takes the new head`,
    );
  }

  if (checkouts.some((tree) => tree.dir === path)) {
    const work = heldWork(path);

    if (work !== null) {
      throw new Error(
        `${path} holds ${work}; keep what you need, then git worktree remove --force ${path}`,
      );
    }

    git(run.main, "worktree", "remove", "--force", path);
  }

  git(run.main, "worktree", "prune");

  if (existsSync(path)) throw new Error(`${path} exists and is no worktree of this repository`);
  mkdirSync(join(path, ".."), { recursive: true });
  git(run.main, "worktree", "add", "--quiet", "-B", pr.headRefName, path, fetched);
}

function verifyAgentLeft(run: Run, worktree: string, branch: string, pushed: string): void {
  const head = command(["git", "symbolic-ref", "--quiet", "HEAD"], worktree).out.trim();

  if (head !== `refs/heads/${branch}`) {
    throw new Error(`the agent left HEAD on ${head === "" ? "no branch" : head}`);
  }

  const dirty = git(worktree, "status", "--porcelain");

  if (dirty !== "") {
    throw new Error(`the agent left changes uncommitted: ${dirty.split("\n").join(", ")}`);
  }

  if (command(["git", "merge-base", "--is-ancestor", pushed, "HEAD"], worktree).code !== 0) {
    throw new Error(
      `the agent rewrote ${shortSha(pushed)}, the head on origin: the run pushes only a fast-forward`,
    );
  }

  const made = commitsIn(worktree, `${pushed}..HEAD`);

  if (made.kind === "unread") throw new Error(made.why);

  const unmarked = made.commits.filter((commit) => commit.agentRun !== run.id);

  if (unmarked.length > 0) {
    throw new Error(
      `the agent committed ${unmarked.map((commit) => shortSha(commit.sha)).join(", ")} without the trailer ${AGENT_TRAILER}: ${run.id}; the run pushes none of its commits`,
    );
  }
}

/** What one pull request's handling has settled so far: the heads the next runs leave alone. */
interface Settled {
  readonly heads: string[];
}

/**
 * One agent round on `why`, its commits pushed as a fast-forward under a lease. The round counts against `update`'s
 * budget once the agent has exited on its own: a stop or a crash spends none.
 */
async function agentRound(
  run: Run,
  pr: RenovatePr,
  worktree: string,
  why: string,
  { log, settled, update }: { log: number; settled: Settled; update: string },
): Promise<void> {
  const prompt = promptFor(
    readFileSync(PROMPT, "utf8"),
    {
      worktree,
      branch: pr.headRefName,
      number: String(pr.number),
      title: pr.title,
      url: pr.url,
      why,
      trailer: `${AGENT_TRAILER}: ${run.id}`,
    },
    PROMPT,
  );

  const pushed = git(worktree, "rev-parse", "HEAD");

  settled.heads.push(pushed);

  // The sessions the agent starts leave the types pipeline alone, as its own do.
  const agent = await streamed(
    ["claude", "-p", "--model", "opus", "--permission-mode", "auto", prompt],
    worktree,
    log,
    run.progress,
    { [TYPES_RUN_GUARD]: "1" },
  );

  checkStop(run.progress);
  const cannot = CANNOT_REPAIR.exec(agent.output)?.[0];

  if (agent.code !== 0 && cannot === undefined) {
    throw new Error(`claude -p exited ${agent.code}`);
  }

  recount(run.state.rounds, update, (spent) => spent + 1);

  if (cannot !== undefined) throw new Error(`the agent reports ${cannot}`);
  verifyAgentLeft(run, worktree, pr.headRefName, pushed);
  const head = git(worktree, "rev-parse", "HEAD");

  if (head === pushed) throw new Error("the agent committed nothing");

  const push = await streamed(
    [
      "git",
      "push",
      `--force-with-lease=${pr.headRefName}:${pushed}`,
      "origin",
      `HEAD:refs/heads/${pr.headRefName}`,
    ],
    worktree,
    log,
    run.progress,
  );

  if (push.code !== 0) {
    const refused = `git push exited ${push.code}: ${lastNonEmptyLine(push.output)}`;

    if (isTransient(push.output)) throw new TransientError(refused);

    throw new Error(`${refused}; Renovate may have pushed meanwhile`);
  }

  settled.heads.push(head);
}

/** The branch head land.ts left on origin, when it is the worktree's own: a head this run pushed. */
function landedOrPushedHead(run: Run, pr: RenovatePr, worktree: string): string | null {
  const local = git(worktree, "rev-parse", "HEAD");

  const remote = command(["git", "ls-remote", "origin", `refs/heads/${pr.headRefName}`], run.main)
    .out.split("\t")[0]
    ?.trim();

  return remote === local ? local : null;
}

/** Removes the worktree unless it holds work or cannot be read; answers it when kept. Never throws. */
function dropWorktree(run: Run, worktree: string, log: number): string | null {
  if (!existsSync(worktree)) return null;

  try {
    const held = heldWork(worktree);

    if (held === null) {
      git(run.main, "worktree", "remove", "--force", worktree);

      return null;
    }

    writeSync(log, `${worktree} kept: it holds ${held}\n`);
  } catch (error) {
    writeSync(log, `${worktree} kept: ${error instanceof Error ? error.message : String(error)}\n`);
  }

  return worktree;
}

/** The pull request's end: landed, deferred, or why it was not, with its worktree kept. */
async function handle(
  run: Run,
  pr: RenovatePr,
  { reasons, update }: { reasons: readonly AgentReason[]; update: string },
): Promise<PrOutcome> {
  const worktree = `${run.main}.wt/renovate/${pr.number}`;
  const logFile = prLogPath(run.state, pr.number);
  const log = openSync(logFile, "w");
  const settled: Settled = { heads: [] };
  const spent = () => readCounts(run.state.rounds)[update] ?? 0;
  let made = false;

  /** Deferred to the next daily run, or the human's once deferred `DEFERRALS` times in a row. */
  const defer = (why: string): PrOutcome => {
    let left: string | null = null;

    try {
      left = existsSync(worktree) ? landedOrPushedHead(run, pr, worktree) : null;
    } catch (error) {
      writeSync(log, `${error instanceof Error ? error.message : String(error)}\n`);
    }

    const kept = dropWorktree(run, worktree, log);
    const deferrals = recount(run.state.deferrals, update, (count) => count + 1);

    if (deferrals < DEFERRALS)
      return { kind: "deferred", pr, verdict: why, log: logFile, worktree: kept };

    return {
      kind: "failed",
      pr,
      reason: `deferred ${deferrals} times in a row, the last: ${why}`,
      log: logFile,
      worktree: kept,
      heads: unique([pr.headRefOid, ...settled.heads, ...(left === null ? [] : [left])]),
    };
  };

  try {
    writeSync(log, `#${pr.number} ${pr.headRefName} at ${pr.headRefOid}: ${reasons.join(", ")}\n`);

    let why: string | null = reasons.includes("red")
      ? `CI is red on ${pr.headRefOid}: \`gh pr checks ${pr.number}\` names the red jobs.`
      : null;

    if (why !== null && spent() >= AGENT_ROUNDS) {
      settled.heads.push(pr.headRefOid);
      throw new Error(`CI still red after ${AGENT_ROUNDS} agent rounds: ${why}`);
    }

    await prepareWorktree(run, pr, worktree);
    made = true;

    for (const install of INSTALLS) {
      const installed = await streamed(install, worktree, log, run.progress);

      if (installed.code !== 0) {
        const failed = `${install.join(" ")} exited ${installed.code}`;

        throw isTransient(installed.output) ? new TransientError(failed) : new Error(failed);
      }
    }

    for (;;) {
      if (why !== null) {
        if (spent() >= AGENT_ROUNDS) {
          settled.heads.push(pr.headRefOid);
          throw new Error(`CI still red after ${AGENT_ROUNDS} agent rounds: ${why}`);
        }

        await agentRound(run, pr, worktree, why, { log, settled, update });
      }

      // The run's own land.ts, never the branch's: an old branch carries an old one.
      const landing = await streamed(["bun", LAND, pr.headRefName], worktree, log, run.progress);

      checkStop(run.progress);
      const verdict = landVerdict(landing.output);

      if (landing.code === DEFERRED_EXIT) return defer(verdict);

      recount(run.state.deferrals, update, () => 0);
      settled.heads.push(pr.headRefOid);
      const left = landedOrPushedHead(run, pr, worktree);

      if (left !== null) settled.heads.push(left);

      if (landing.code === 0) {
        git(run.main, "worktree", "remove", "--force", worktree);

        return { kind: "landed", pr, verdict, heads: unique(settled.heads) };
      }

      // Only a red CI is the agent's to repair: a review, a rebase or a timeout is the human's.
      if (!RED_REFUSAL.test(verdict)) throw new Error(`land.ts refused it: ${verdict}`);

      why = `\`bun ./scripts/land.ts ${pr.headRefName}\` refused it: ${verdict}`;
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    writeSync(log, `${reason}\n`);
    const kept = made && existsSync(worktree) ? worktree : null;

    if (run.progress.signal !== null) {
      return { kind: "stopped", pr, signal: run.progress.signal, log: logFile, worktree: kept };
    }

    if (isTransientError(error)) return defer(reason);

    return {
      kind: "failed",
      pr,
      reason,
      log: logFile,
      worktree: kept,
      heads: unique(settled.heads),
    };
  } finally {
    closeSync(log);
  }
}

function unique(heads: readonly string[]): string[] {
  return [...new Set(heads)];
}

/** The risky-path predicate of `origin/dev`'s profile, every path while it does not read, as land.ts does. */
function riskyPaths(cwd: string): RiskyPath {
  const profile = riskyOf(cwd, "origin/dev");

  if (profile.kind === "unreadable") return () => true;

  const globs = profile.risky.map((glob) => new Bun.Glob(glob));

  return (path) => globs.some((glob) => glob.match(path));
}

interface Classified {
  readonly pr: RenovatePr;
  readonly classification: Classification;
  /** The Renovate update its branch carries, null when unread or when Renovate wrote none of it. */
  readonly update: string | null;
}

/** Each open Renovate pull request's owner, its branch read from `origin/dev..<head>` as the last fetch left it. */
function classifyAll(cwd: string, handled: Handled): Promise<readonly Classified[]> {
  const prs = listPrs(cwd);
  const isRisky = riskyPaths(cwd);
  const ghHere = (args: readonly string[]) => ghCli(args, cwd);

  return Promise.all(
    prs.map(async (pr): Promise<Classified> => {
      const branch = commitsIn(cwd, `origin/${DEV}..${pr.headRefOid}`);
      const update = branch.kind === "read" ? updateOf(branch.commits) : null;
      let verdict: CiVerdict;

      try {
        const [pullRequest, push] = await Promise.all([
          ciVerdict(ghHere, { sha: pr.headRefOid, event: "pull_request" }),
          ciVerdict(ghHere, { sha: pr.headRefOid, event: "push" }),
        ]);

        verdict = combinedVerdict(pullRequest, push);
      } catch (error) {
        if (!isTransientError(error)) throw error;

        const why = `gh could not read the CI of ${shortSha(pr.headRefOid)}: ${error instanceof Error ? error.message : String(error)}`;

        return { pr, classification: { owner: "wait", why }, update };
      }

      return { pr, classification: classify(pr, branch, verdict, handled, isRisky), update };
    }),
  );
}

async function dryRun(start: string): Promise<void> {
  const { main } = await worktreesOf(start);
  const state = statePaths(commonDirOf(main));

  for (const { pr, classification } of await classifyAll(main, readHandled(state.handled))) {
    console.log(classificationLine(pr, classification));
  }
}

function settledHeads(outcome: PrOutcome): readonly string[] {
  switch (outcome.kind) {
    case "landed":
    case "failed":
      return outcome.heads;
    case "human":
      return [outcome.pr.headRefOid];
    case "stopped":
    case "deferred":
      return [];
  }
}

async function runAll(start: string): Promise<void> {
  // Every step runs from the main checkout: the worktrees it makes and removes are siblings of it.
  const { main } = await worktreesOf(start);
  process.chdir(main);
  const state = statePaths(commonDirOf(main));
  mkdirSync(state.dir, { recursive: true });
  const startedAt = new Date().toISOString();
  const lock = takeRunLock(state, { pid: process.pid, startedAt });

  if (lock === null) {
    console.error(`renovate-agent: a live run holds ${state.lock}`);

    return;
  }

  const log = openSync(state.runLog, "w");

  const run: Run = {
    id: `${startedAt} ${process.pid}`,
    main,
    state,
    progress: { child: null, signal: null },
  };

  const stop = (signal: NodeJS.Signals) => {
    run.progress.signal ??= signal;
    run.progress.child?.kill("SIGTERM");
  };

  for (const signal of STOP_SIGNALS) process.on(signal, stop);

  try {
    checked(["git", "fetch", "--quiet", "--prune", "origin"], main);
    const classified = await classifyAll(main, readHandled(state.handled));
    const open = classified.map(({ pr }) => pr.number);
    const updates = classified.flatMap(({ update }) => (update === null ? [] : [update]));

    for (const file of [state.rounds, state.deferrals]) {
      writeWhole(file, JSON.stringify(openCounts(readCounts(file), updates)));
    }

    for (const { pr, classification } of classified) {
      writeSync(log, `${classificationLine(pr, classification)}\n`);
    }

    const owned = classified.flatMap(({ pr, classification }) =>
      classification.owner === "agent"
        ? [{ pr, reasons: classification.reasons, update: classification.update }]
        : [],
    );

    const end = (outcome: PrOutcome) => {
      const line = outcomeLine(outcome);
      writeSync(log, `${line}\n`);
      report(state.report, line);
      notify(NOTICE, line, outcome.kind === "failed" || outcome.kind === "human", log);

      writeWhole(
        state.handled,
        JSON.stringify(
          recordHandled(readHandled(state.handled), open, {
            [String(outcome.pr.number)]: settledHeads(outcome),
          }),
        ),
      );
    };

    for (const { pr, classification } of classified) {
      if (classification.owner === "human") end({ kind: "human", pr, why: classification.why });
    }

    if (owned.length > 0) probeSigning(main);

    for (const { pr, reasons, update } of owned) {
      const outcome = await handle(run, pr, { reasons, update });
      end(outcome);

      if (outcome.kind === "stopped") break;
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const stopped = run.progress.signal !== null;
    const transient = !stopped && isTransientError(error);

    const line = stopped
      ? `Renovate agent: the run was stopped by ${run.progress.signal} (log: ${state.runLog}); the next daily run starts again`
      : transient
        ? `Renovate agent: the run could not reach origin or GitHub: ${reason} (log: ${state.runLog}); the next daily run starts again`
        : `Renovate agent: the run failed: ${reason} (log: ${state.runLog})`;

    writeSync(log, `${line}\n`);
    report(state.report, line);
    notify(NOTICE, line, !stopped && !transient, log);
  } finally {
    closeSync(log);
    closeSync(lock);
  }
}

if (import.meta.main) {
  const [action, flag, ...rest] = process.argv.slice(2);

  if (action !== "run" || (flag !== undefined && flag !== "--dry-run") || rest.length > 0) {
    console.error("Usage: bun ./scripts/renovate-agent.ts run [--dry-run]");
    process.exitCode = 2;
  } else {
    try {
      if (flag === "--dry-run") await dryRun(process.cwd());
      else await runAll(process.cwd());
    } catch (error) {
      console.error(`renovate-agent: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
}
