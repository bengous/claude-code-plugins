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
 * review verdict, which no unattended agent records. This run owns the others
 * Renovate leaves: a red one, a major (Renovate's `major` label), and one
 * whose files touch the e2e paths (`isE2ePath`). A head this run already
 * handled is left until Renovate pushes another.
 *
 * Each owned pull request gets its own worktree, `<main worktree>.wt/
 * renovate/<number>`, at the branch's head fetched again, which must still be
 * the listed one, with the dependencies installed. On a red one the run first
 * runs the repository's fixers at the updated versions, `bun x oxlint --fix`
 * then `bun run fmt`, and commits what they change, signed with the user's
 * key. When that change touches a risky path and the branch holds Renovate's
 * commits and that one alone, the run records the verdict `land.ts` reads
 * (`scripts/review-verdict.ts`), saying no review was made: the patch is the
 * update plus a repair anyone reproduces by running the fixers again, and any
 * later commit changes it. A commit or a push the hooks refuse is dropped.
 * When the fixers changed nothing or were dropped, a headless Claude
 * (`scripts/renovate-agent.prompt.md`) commits the repair instead. The run
 * pushes each repair, a fast-forward under a lease, and runs
 * `scripts/land.ts`, which waits for CI, runs the e2e suite when the branch
 * needs it and lands the branch on `dev`.
 * A landing refused because CI is red goes back to the agent, two agent
 * rounds per pull request in all; any other refusal is retried by the next
 * daily run, and the second in a row goes to the human. Each
 * end, landed or not, is a line the next session start shows and a desktop
 * notice. The lock, the logs, the handled heads and the lines not yet shown
 * live in `<git common dir>/renovate-agent/`.
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
import { type CiVerdict, ciVerdict, ghCli } from "./ci-wait.ts";
import { RUN_GUARD as TYPES_RUN_GUARD } from "./claude-code-types.ts";
import { riskyOf } from "./land.ts";
import {
  type ChildSlot,
  command,
  commonDirOf,
  gh,
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
import { BASE, patchIdOf, postVerdict } from "./review-verdict.ts";

export const MAJOR_LABEL = "major";

const RENOVATE_AUTHOR = "app/renovate";

const DEV = "dev";

const PROMPT = join(import.meta.dir, "renovate-agent.prompt.md");

const NOTICE = "Renovate agent";

/** Agent rounds per pull request, in all: each one answers a red CI. */
export const AGENT_ROUNDS = 2;

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

export type AgentReason = "red" | "major" | "e2e";

export type Classification =
  | { readonly owner: "renovate"; readonly why: string }
  | { readonly owner: "agent"; readonly reasons: readonly AgentReason[] }
  | { readonly owner: "human"; readonly why: string }
  | { readonly owner: "wait"; readonly why: string }
  | { readonly owner: "handled"; readonly why: string };

/** Whether a path needs a human review verdict before `land.ts` lands it. */
export type RiskyPath = (path: string) => boolean;

/**
 * How a pull request ended. `heads` are the heads it settles, which the next
 * runs leave alone: the listed head once a costly step ran (an agent round or
 * a landing), and each head this run pushed; none when it failed before those
 * or was stopped.
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
      readonly kind: "refused";
      readonly pr: RenovatePr;
      readonly verdict: string;
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
  | { readonly kind: "human"; readonly pr: RenovatePr; readonly why: string };

/**
 * How many times in a row `land.ts` refused each pull request for a reason
 * other than a red CI. No refusal text is classified: the first is retried by
 * the next daily run, the second goes to the human.
 */
export type Refusals = Readonly<Record<string, number>>;

export const REFUSALS_BEFORE_HUMAN = 2;

/** The author of Renovate's commits, as git records them. */
export const RENOVATE_EMAIL = "29139614+renovate[bot]@users.noreply.github.com";

interface Fixer {
  readonly name: string;
  readonly fix: readonly string[];
  readonly version: readonly string[];
}

/** The repository's own fixers: oxlint's safe fixes, then the `fmt` script of `package.json`. */
const FIXERS: readonly Fixer[] = [
  {
    name: "oxlint",
    fix: ["bun", "x", "oxlint", "--fix"],
    version: ["bun", "x", "oxlint", "--version"],
  },
  { name: "oxfmt", fix: ["bun", "run", "fmt"], version: ["bun", "x", "oxfmt", "--version"] },
];

/** A fixer as it ran on the branch. */
export interface RanFixer {
  readonly name: string;
  readonly version: string;
  readonly command: string;
}

/** A commit of the branch since `origin/dev`, by its author's email. */
export interface BranchCommit {
  readonly sha: string;
  readonly author: string;
}

export type FixerVerdict =
  | { readonly kind: "record"; readonly risky: readonly string[] }
  | { readonly kind: "none"; readonly why: string };

/** The version a tool's `--version` prints. */
export function versionOf(output: string): string {
  const version = /\d+\.\d+\.\d+[\w.+-]*/u.exec(output)?.[0];

  if (version === undefined) throw new Error(`no version in ${JSON.stringify(output.trim())}`);

  return version;
}

export function fixerCommitMessage(fixers: readonly RanFixer[], renovateHead: string): string {
  const names = fixers.map((fixer) => `${fixer.name} ${fixer.version}`).join(" and ");
  const commands = fixers.map((fixer) => `\`${fixer.command}\``).join(", then ");

  return `fix(lint): apply the fixes of ${names}\n\n${commands}, run by scripts/renovate-agent.ts on Renovate's head ${renovateHead}, with no agent: this commit is what they changed.`;
}

/**
 * Whether the run records a verdict for the fixers' commit `fixer`, given the branch's `commits` since `origin/dev`,
 * newest first, and the paths the fixers changed: only when they changed a risky path, `fixer` is the head and every
 * commit under it is Renovate's, so the patch is Renovate's update and a repair anyone can reproduce.
 */
export function fixerVerdict({
  commits,
  fixer,
  fixed,
  isRisky,
}: {
  readonly commits: readonly BranchCommit[];
  readonly fixer: string;
  readonly fixed: readonly string[];
  readonly isRisky: RiskyPath;
}): FixerVerdict {
  const risky = fixed.filter((path) => isRisky(path));

  if (risky.length === 0) return { kind: "none", why: "the fixers' repair touches no risky path" };

  const [newest, ...below] = commits;

  if (newest?.sha !== fixer) {
    return {
      kind: "none",
      why: `the branch's head is ${newest === undefined ? "no commit" : shortSha(newest.sha)}, not the fixers' ${shortSha(fixer)}`,
    };
  }

  const foreign = below.find((commit) => commit.author !== RENOVATE_EMAIL);

  if (foreign !== undefined) {
    return {
      kind: "none",
      why: `the branch holds ${shortSha(foreign.sha)} by ${foreign.author} besides Renovate's commits and the fixers' ${shortSha(fixer)}`,
    };
  }

  if (below.length === 0) {
    return {
      kind: "none",
      why: `the branch holds no Renovate commit under the fixers' ${shortSha(fixer)}`,
    };
  }

  return { kind: "record", risky };
}

/** What the run's verdict says under its marker: no review, a repair the named fixers reproduce. */
export function fixerVerdictWhy(fixers: readonly RanFixer[], renovateHead: string): string {
  const ran = fixers.map((fixer) => `${fixer.name} ${fixer.version} (\`${fixer.command}\`)`);

  return `No review: \`scripts/renovate-agent.ts\` ran ${ran.join(", then ")} on Renovate's head ${renovateHead} and committed what they changed, a repair anyone reproduces by running them again. \`scripts/land.ts\` lands this change while its patch against \`${BASE}\` stays the same: any other commit changes it, and the branch then waits for a human review.`;
}

/** Opus for a major update, whose breaking changes the repair has to follow; Sonnet for the rest. */
export function agentModel(reasons: readonly AgentReason[]): "opus" | "sonnet" {
  return reasons.includes("major") ? "opus" : "sonnet";
}

/** The outcome to report and the refusal counts once it is recorded. */
export interface Counted {
  readonly outcome: PrOutcome;
  readonly refusals: Refusals;
}

export interface StatePaths extends LockPaths {
  readonly dir: string;
  readonly day: string;
  readonly handled: string;
  readonly refusals: string;
  readonly report: string;
  readonly runLog: string;
  readonly spawnLog: string;
}

/** The heads this run already handled, per pull request number. */
export type Handled = Readonly<Record<string, readonly string[]>>;

export function statePaths(commonDir: string): StatePaths {
  const dir = join(commonDir, "renovate-agent");

  return {
    dir,
    lock: join(dir, "run.lock"),
    holder: join(dir, "holder.json"),
    day: join(dir, "day"),
    handled: join(dir, "handled.json"),
    refusals: join(dir, "refusals.json"),
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
 * Who lands `pr`, given its `ci.yml` verdict, the heads already handled and
 * the risky paths. Nobody acts before CI concludes: Renovate would not merge a
 * running branch, and `land.ts` refuses a head with no run.
 */
export function classify(
  pr: RenovatePr,
  verdict: CiVerdict,
  handled: Handled,
  isRisky: RiskyPath,
): Classification {
  const sha = shortSha(pr.headRefOid);

  if ((handled[String(pr.number)] ?? []).includes(pr.headRefOid)) {
    return { owner: "handled", why: `${sha} was handled by an earlier run; waits for a new head` };
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

  if (reasons.length > 0) return { owner: "agent", reasons };

  return {
    owner: "renovate",
    why: `green on ${sha}, not major, no e2e path: Renovate's branch automerge lands it`,
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
    case "refused":
      return `${head}: land.ts refused it: ${outcome.verdict} (log: ${outcome.log}${keptNote(outcome.worktree)}); the next daily run tries again, and a second refusal in a row comes to you`;
    case "stopped":
      return `${head}: the run was stopped by ${outcome.signal} (log: ${outcome.log}${keptNote(outcome.worktree)}); the next daily run takes it again`;
    case "failed":
      return `${head} needs you: ${outcome.reason} (log: ${outcome.log}${keptNote(outcome.worktree)}). ${outcome.pr.url}`;
  }
}

function keptNote(worktree: string | null): string {
  return worktree === null ? "" : `; its worktree, ${worktree}, is kept as it is`;
}

/**
 * The outcome to report for `outcome` given the refusals counted so far, and
 * the counts after it. A refusal below the threshold settles nothing; the one
 * reaching it fails, settling the heads it names. Any other end clears the count.
 */
export function afterRefusals(
  outcome: PrOutcome,
  refusals: Refusals,
  open: readonly number[],
): Counted {
  const key = String(outcome.pr.number);

  const kept = Object.fromEntries(
    Object.entries(refusals).filter(([number]) => open.includes(Number(number)) && number !== key),
  );

  if (outcome.kind === "stopped") {
    const count = refusals[key];

    return { outcome, refusals: count === undefined ? kept : { ...kept, [key]: count } };
  }

  if (outcome.kind !== "refused") return { outcome, refusals: kept };

  const count = (refusals[key] ?? 0) + 1;

  if (count < REFUSALS_BEFORE_HUMAN) return { outcome, refusals: { ...kept, [key]: count } };

  return {
    outcome: {
      kind: "failed",
      pr: outcome.pr,
      reason: `land.ts refused it ${count} runs in a row, last: ${outcome.verdict}`,
      log: outcome.log,
      worktree: outcome.worktree,
      heads: outcome.heads,
    },
    refusals: kept,
  };
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

function listPrs(cwd: string): readonly RenovatePr[] {
  return parsePrList(
    gh(
      cwd,
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
    ),
  );
}

function readHandled(file: string): Handled {
  // SAFETY: only this run writes the file, whole, from a Handled.
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Handled) : {};
}

function readRefusals(file: string): Refusals {
  // SAFETY: only this run writes the file, whole, from a Refusals.
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Refusals) : {};
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
    // Its own process group, so a stop reaches land.ts's dev copy and the commands it runs.
    detached: true,
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
  git(run.main, "fetch", "--quiet", "origin", `+refs/heads/${pr.headRefName}:${ref}`);
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

function verifyAgentLeft(worktree: string, branch: string, pushed: string): void {
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
}

/** What one pull request's handling has settled so far: the heads the next runs leave alone. */
interface Settled {
  readonly heads: string[];
}

/** One agent round on `why`, its commits pushed as a fast-forward under a lease. */
async function agentRound(
  run: Run,
  pr: RenovatePr,
  worktree: string,
  why: string,
  reasons: readonly AgentReason[],
  { log, settled }: { log: number; settled: Settled },
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
    },
    PROMPT,
  );

  const pushed = git(worktree, "rev-parse", "HEAD");

  settled.heads.push(pushed);

  // The sessions the agent starts leave the types pipeline alone, as its own do.
  const agent = await streamed(
    ["claude", "-p", "--model", agentModel(reasons), "--permission-mode", "auto", prompt],
    worktree,
    log,
    run.progress,
    { [TYPES_RUN_GUARD]: "1" },
  );

  checkStop(run.progress);
  const cannot = CANNOT_REPAIR.exec(agent.output)?.[0];

  if (cannot !== undefined) throw new Error(`the agent reports ${cannot}`);

  if (agent.code !== 0) throw new Error(`claude -p exited ${agent.code}`);
  verifyAgentLeft(worktree, pr.headRefName, pushed);
  const head = git(worktree, "rev-parse", "HEAD");

  if (head === pushed) throw new Error("the agent committed nothing");

  const push = await pushHead(run, pr, worktree, pushed, log);

  if (push.code !== 0) {
    throw new Error(
      `git push exited ${push.code}: ${lastNonEmptyLine(push.output)}; Renovate may have pushed meanwhile`,
    );
  }

  settled.heads.push(head);
}

/** Pushes the worktree's head to the branch as a fast-forward, under a lease on `pushed`, the head origin holds. */
function pushHead(
  run: Run,
  pr: RenovatePr,
  worktree: string,
  pushed: string,
  log: number,
): Promise<{ code: number; output: string }> {
  return streamed(
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
}

/**
 * The fixers' round, before the first agent round on a red branch: oxlint's safe fixes and oxfmt at the versions the
 * update installed, their changes committed and pushed as `agentRound` pushes; whether it pushed. When their change
 * touches a risky path on a branch of Renovate's commits and theirs alone, the run records the verdict `land.ts`
 * reads, which says no review was made. A commit or a push the hooks refuse is dropped, and the agent round follows.
 */
async function fixerRound(
  run: Run,
  pr: RenovatePr,
  worktree: string,
  { log, settled }: { log: number; settled: Settled },
): Promise<boolean> {
  const ran: RanFixer[] = [];

  for (const fixer of FIXERS) {
    const version = await streamed(fixer.version, worktree, log, run.progress);

    if (version.code !== 0) throw new Error(`${fixer.version.join(" ")} exited ${version.code}`);

    const fix = await streamed(fixer.fix, worktree, log, run.progress);

    if (fix.code !== 0) writeSync(log, `${fixer.fix.join(" ")} exited ${fix.code}\n`);

    ran.push({
      name: fixer.name,
      version: versionOf(version.output),
      command: fixer.fix.join(" "),
    });
  }

  checkStop(run.progress);

  const fixed = git(worktree, "diff", "--name-only", "--no-renames", "-z")
    .split("\0")
    .filter((path) => path !== "");

  if (fixed.length === 0) return false;

  const drop = (why: string) => {
    git(worktree, "reset", "--quiet", "--hard", pr.headRefOid);
    writeSync(log, `the fixers' change is dropped, ${why}; the agent round follows\n`);

    return false;
  };

  const commit = await streamed(
    ["git", "commit", "--quiet", "--all", "-m", fixerCommitMessage(ran, pr.headRefOid)],
    worktree,
    log,
    run.progress,
  );

  checkStop(run.progress);

  if (commit.code !== 0) return drop(`git commit exited ${commit.code}`);

  const head = git(worktree, "rev-parse", "HEAD");
  const push = await pushHead(run, pr, worktree, pr.headRefOid, log);

  checkStop(run.progress);

  if (push.code !== 0) {
    const remote = remoteHeadOf(run, pr) ?? "";

    if (remote !== pr.headRefOid) {
      throw new Error(
        `git push exited ${push.code}: ${lastNonEmptyLine(push.output)}; origin holds ${remote === "" ? "no head read" : shortSha(remote)} for ${pr.headRefName}, not the listed ${shortSha(pr.headRefOid)}`,
      );
    }

    return drop(`git push exited ${push.code}: ${lastNonEmptyLine(push.output)}`);
  }

  settled.heads.push(pr.headRefOid, head);

  const commits = git(worktree, "log", "--format=%H%x09%ae", `${BASE}..HEAD`)
    .split("\n")
    .map((line): BranchCommit => {
      const [sha = "", author = ""] = line.split("\t");

      return { sha, author };
    });

  const verdict = fixerVerdict({ commits, fixer: head, fixed, isRisky: riskyPaths(run.main) });

  if (verdict.kind === "none") {
    writeSync(log, `no verdict recorded: ${verdict.why}\n`);

    return true;
  }

  const patchId = patchIdOf(worktree, BASE, head);

  if (patchId.kind === "failed") throw new Error(patchId.why);

  const posted = postVerdict(worktree, pr.number, patchId.id, fixerVerdictWhy(ran, pr.headRefOid));

  if (posted.kind === "refused") throw new Error(posted.why);

  writeSync(
    log,
    `recorded the fixers' verdict on #${pr.number} for ${verdict.risky.join(", ")}: patch-id ${patchId.id}\n`,
  );

  return true;
}

/** The head origin holds for the branch, read now. */
function remoteHeadOf(run: Run, pr: RenovatePr): string | undefined {
  return command(["git", "ls-remote", "origin", `refs/heads/${pr.headRefName}`], run.main)
    .out.split("\t")[0]
    ?.trim();
}

/** The branch head land.ts left on origin, when it is the worktree's own: a head this run pushed. */
function landedOrPushedHead(run: Run, pr: RenovatePr, worktree: string): string | null {
  const local = git(worktree, "rev-parse", "HEAD");

  return remoteHeadOf(run, pr) === local ? local : null;
}

/** The pull request's end: landed, or why it was not, with its worktree kept. */
async function handle(
  run: Run,
  pr: RenovatePr,
  reasons: readonly AgentReason[],
): Promise<PrOutcome> {
  const worktree = `${run.main}.wt/renovate/${pr.number}`;
  const logFile = prLogPath(run.state, pr.number);
  const log = openSync(logFile, "w");
  const settled: Settled = { heads: [] };
  let made = false;

  try {
    writeSync(log, `#${pr.number} ${pr.headRefName} at ${pr.headRefOid}: ${reasons.join(", ")}\n`);
    await prepareWorktree(run, pr, worktree);
    made = true;

    for (const install of INSTALLS) {
      const installed = await streamed(install, worktree, log, run.progress);

      if (installed.code !== 0) throw new Error(`${install.join(" ")} exited ${installed.code}`);
    }

    let why: string | null = reasons.includes("red")
      ? `CI is red on ${pr.headRefOid}: \`gh pr checks ${pr.number}\` names the red jobs.`
      : null;

    if (why !== null && (await fixerRound(run, pr, worktree, { log, settled }))) why = null;

    let rounds = 0;

    for (;;) {
      if (why !== null) {
        if (rounds === AGENT_ROUNDS) {
          throw new Error(`CI still red after ${AGENT_ROUNDS} agent rounds: ${why}`);
        }

        rounds += 1;
        await agentRound(run, pr, worktree, why, reasons, { log, settled });
      }

      settled.heads.push(pr.headRefOid);

      const landing = await streamed(
        ["bun", "./scripts/land.ts", pr.headRefName],
        worktree,
        log,
        run.progress,
      );

      checkStop(run.progress);
      const verdict = lastNonEmptyLine(landing.output);
      const left = landedOrPushedHead(run, pr, worktree);

      if (left !== null) settled.heads.push(left);

      if (landing.code === 0) {
        git(run.main, "worktree", "remove", "--force", worktree);

        return { kind: "landed", pr, verdict, heads: unique(settled.heads) };
      }

      // Only a red CI is the agent's to repair; any other refusal is retried by the next run, then the human's.
      if (!RED_REFUSAL.test(verdict)) {
        return {
          kind: "refused",
          pr,
          verdict,
          log: logFile,
          worktree: existsSync(worktree) ? worktree : null,
          heads: unique(settled.heads),
        };
      }

      why = `\`bun ./scripts/land.ts ${pr.headRefName}\` refused it: ${verdict}`;
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    writeSync(log, `${reason}\n`);
    const kept = made && existsSync(worktree) ? worktree : null;

    if (run.progress.signal !== null) {
      return { kind: "stopped", pr, signal: run.progress.signal, log: logFile, worktree: kept };
    }

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

function classifyAll(
  cwd: string,
  handled: Handled,
): Promise<readonly { pr: RenovatePr; classification: Classification }[]> {
  const prs = listPrs(cwd);
  const isRisky = riskyPaths(cwd);
  const ghHere = (args: readonly string[]) => ghCli(args, cwd);

  return Promise.all(
    prs.map(async (pr) => {
      const [pullRequest, push] = await Promise.all([
        ciVerdict(ghHere, { sha: pr.headRefOid, event: "pull_request" }),
        ciVerdict(ghHere, { sha: pr.headRefOid, event: "push" }),
      ]);

      return {
        pr,
        classification: classify(pr, combinedVerdict(pullRequest, push), handled, isRisky),
      };
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
    case "refused":
    case "stopped":
      return [];
  }
}

async function runAll(start: string): Promise<void> {
  // Every step runs from the main checkout: the worktrees it makes and removes are siblings of it.
  const { main } = await worktreesOf(start);
  process.chdir(main);
  const state = statePaths(commonDirOf(main));
  mkdirSync(state.dir, { recursive: true });
  const lock = takeRunLock(state, { pid: process.pid, startedAt: new Date().toISOString() });

  if (lock === null) {
    console.error(`renovate-agent: a live run holds ${state.lock}`);

    return;
  }

  const log = openSync(state.runLog, "w");
  const run: Run = { main, state, progress: { child: null, signal: null } };

  const stop = (signal: NodeJS.Signals) => {
    run.progress.signal ??= signal;
    const child = run.progress.child;

    if (child === null) return;

    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      // The group may have exited between its last read and this signal.
      // SAFETY: process.kill throws only a system error, which carries `code`.
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };

  for (const signal of STOP_SIGNALS) process.on(signal, stop);

  try {
    git(main, "fetch", "--quiet", "--prune", "origin");
    const classified = await classifyAll(main, readHandled(state.handled));
    const open = classified.map(({ pr }) => pr.number);

    for (const { pr, classification } of classified) {
      writeSync(log, `${classificationLine(pr, classification)}\n`);
    }

    const owned = classified.flatMap(({ pr, classification }) =>
      classification.owner === "agent" ? [{ pr, reasons: classification.reasons }] : [],
    );

    const end = (ended: PrOutcome) => {
      const counted = afterRefusals(ended, readRefusals(state.refusals), open);
      writeWhole(state.refusals, JSON.stringify(counted.refusals));
      const { outcome } = counted;
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

    for (const { pr, reasons } of owned) {
      const outcome = await handle(run, pr, reasons);
      end(outcome);

      if (outcome.kind === "stopped") break;
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    const line =
      run.progress.signal === null
        ? `Renovate agent: the run failed: ${reason} (log: ${state.runLog})`
        : `Renovate agent: the run was stopped by ${run.progress.signal} (log: ${state.runLog}); the next daily run starts again`;

    writeSync(log, `${line}\n`);
    report(state.report, line);
    notify(NOTICE, line, run.progress.signal === null, log);
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
