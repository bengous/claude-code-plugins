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
 * `profile.review.risky` lands through `land.ts` only with a review verdict
 * for its patch: a review's, or this run's for a repair of the lint and
 * format fixers alone, whose configuration is itself risky. Without one it
 * goes to the human; with one, the run lands it again, and a red CI sends it
 * to the human, since an agent commit would void the verdict. This run owns
 * the others Renovate leaves: a red one, a major (Renovate's `major` label),
 * and one whose files touch the e2e paths (`isE2ePath`). A head this run
 * already handled is left until Renovate pushes another.
 *
 * Each owned pull request gets its own worktree, `<main worktree>.wt/
 * renovate/<number>`, at the branch's head fetched again, which must still be
 * the listed one, with the dependencies installed. On a red one the run first
 * rebases the branch onto `origin/dev`, as CI lints it, and runs oxfmt,
 * `oxlint --fix` and oxfmt again at the updated versions. What they change is
 * committed, signed with the user's key, once the pre-commit hook passes on
 * it. A change off the risky paths is pushed; one on them is pushed only when
 * the branch under it holds Renovate's commits alone, themselves off the
 * risky paths, and the run then records the verdict `land.ts` reads
 * (`scripts/review-verdict.ts`), saying no review was made: the patch is the
 * update plus a repair anyone reproduces, and any later commit changes it.
 * Otherwise that change goes to the human, unpushed. A fixer's failure or a
 * pre-commit refusal drops the change, and a headless Claude
 * (`scripts/renovate-agent.prompt.md`) commits the repair instead, as when
 * the fixers change nothing. The run pushes each repair under a lease on the
 * head origin holds and runs `scripts/land.ts`, which waits for CI, runs the
 * e2e suite when the branch needs it and lands the branch on `dev`.
 * A landing refused because CI is red goes back to the agent, two agent
 * rounds per pull request in all, or to the human once the run posted a
 * verdict for the branch's patch; any other refusal is retried by the next
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
  SIGNING_FAILED,
  STOP_SIGNALS,
  takeRunLock,
  worktreesOf,
  writeWhole,
} from "./lib/headless-run.ts";
import { BASE, type Comment, patchIdOf, postVerdict, short, verdictsOf } from "./review-verdict.ts";

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

/** `vouched`: a risky head whose patch a verdict on the pull request names, which only `land.ts` runs on. */
export type AgentReason = "red" | "major" | "e2e" | "vouched";

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

export const FMT_GLOBS = ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.mjs", "**/*.cjs"] as const;

type FixerTool = "oxfmt" | "oxlint";

interface FixerStep {
  readonly tool: FixerTool;
  readonly args: readonly string[];
}

const OXFMT: FixerStep = { tool: "oxfmt", args: ["bun", "x", "oxfmt", ...FMT_GLOBS] };

// `--silent --format=agent` prints nothing on a finding left without a fixer, so a failure is told by its output.
const OXLINT_FIX: FixerStep = {
  tool: "oxlint",
  args: ["bun", "x", "oxlint", "--fix", "--silent", "--format=agent"],
};

// As `rewritersFor` in .claude/hooks/format-on-edit.ts: a line oxfmt wraps can need oxlint's blank lines, and a fix
// can leave code oxfmt would change.
const FIXER_STEPS: readonly FixerStep[] = [OXFMT, OXLINT_FIX, OXFMT];

export type FixerVersions = Readonly<Record<FixerTool, string>>;

/** A commit of the branch since `origin/dev`, by its author's email. */
export interface BranchCommit {
  readonly sha: string;
  readonly author: string;
}

export type FixerVerdict =
  | { readonly kind: "unneeded" }
  | { readonly kind: "record"; readonly risky: readonly string[] }
  | { readonly kind: "human"; readonly why: string };

export function versionOf(output: string): string {
  const version = /\d+\.\d+\.\d+[\w.+-]*/u.exec(output)?.[0];

  if (version === undefined) throw new Error(`no version in ${JSON.stringify(output.trim())}`);

  return version;
}

/** Why a fixer's run failed; null when it ran, oxlint's silent exit 1 for findings left without a fixer included. */
export function fixerFailure(tool: FixerTool, code: number, output: string): string | null {
  if (code === 0 || (tool === "oxlint" && code === 1 && output.trim() === "")) return null;

  return `${tool} exited ${code}: ${lastNonEmptyLine(output)}`;
}

function fixersRan(versions: FixerVersions): string {
  return `oxfmt ${versions.oxfmt}, \`oxlint --fix\` of oxlint ${versions.oxlint}, then oxfmt again`;
}

export function fixerCommitMessage(
  versions: FixerVersions,
  renovateHead: string,
  base: string,
): string {
  return `fix(lint): apply the fixes of oxfmt ${versions.oxfmt} and oxlint ${versions.oxlint}\n\n${fixersRan(versions)}, run by scripts/renovate-agent.ts on Renovate's head ${renovateHead} rebased onto ${BASE} at ${base}, with no agent: this commit is what they changed.`;
}

/**
 * Whether the run vouches for the fixers' commit, given the commits `under` it since `origin/dev` and the paths those
 * change, `renovatePaths`, both read from git: a repair off the risky paths needs no verdict, and one on them is
 * vouched for only over Renovate's commits alone, themselves off the risky paths, else it is the human's.
 */
export function fixerVerdict({
  under,
  renovatePaths,
  fixed,
  isRisky,
}: {
  readonly under: readonly BranchCommit[];
  readonly renovatePaths: readonly string[];
  readonly fixed: readonly string[];
  readonly isRisky: RiskyPath;
}): FixerVerdict {
  const risky = fixed.filter((path) => isRisky(path));

  if (risky.length === 0) return { kind: "unneeded" };

  const human = (why: string): FixerVerdict => ({
    kind: "human",
    why: `touches risky paths (${risky.join(", ")}) through the lint and format fixers' repair, which the run vouches for only on Renovate's commits: ${why}`,
  });

  const foreign = under.find((commit) => commit.author !== RENOVATE_EMAIL);

  if (foreign !== undefined) return human(`${short(foreign.sha)} is by ${foreign.author}`);

  if (under.length === 0) return human("the branch holds none");

  const renovateRisky = renovatePaths.filter((path) => isRisky(path));

  if (renovateRisky.length > 0) {
    return human(`those change risky paths too (${renovateRisky.join(", ")})`);
  }

  return { kind: "record", risky };
}

/** What the run's verdict says under its marker: no review, a repair the named fixers reproduce. */
export function fixerVerdictWhy(
  versions: FixerVersions,
  renovateHead: string,
  base: string,
): string {
  return `No review: \`scripts/renovate-agent.ts\` rebased Renovate's head ${renovateHead} onto \`${BASE}\` at ${base}, ran ${fixersRan(versions)}, and committed what they changed: a repair anyone reproduces by running them again, under a lint and format configuration \`profile.review.risky\` holds. \`scripts/land.ts\` lands this change while its patch against \`${BASE}\` stays the same: any other commit changes it, and the branch then waits for a human review.`;
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
 * Who lands `pr`, given its `ci.yml` verdict, the heads already handled, the
 * risky paths and whether a verdict on the pull request names its head's
 * patch. Nobody acts before CI concludes: Renovate would not merge a running
 * branch, and `land.ts` refuses a head with no run. A risky head with a
 * verdict goes back to `land.ts` alone: an agent commit would void it.
 */
export function classify(
  pr: RenovatePr,
  verdict: CiVerdict,
  handled: Handled,
  isRisky: RiskyPath,
  vouched: boolean,
): Classification {
  const sha = short(pr.headRefOid);

  if ((handled[String(pr.number)] ?? []).includes(pr.headRefOid)) {
    return { owner: "handled", why: `${sha} was handled by an earlier run; waits for a new head` };
  }

  if (verdict.kind === "running") return { owner: "wait", why: `CI still runs on ${sha}` };

  if (verdict.kind === "none")
    return { owner: "wait", why: `no ci.yml pull_request run on ${sha}` };

  const risky = pr.files.filter((path) => isRisky(path));

  if (risky.length > 0 && !vouched) {
    return {
      owner: "human",
      why: `touches risky paths (${risky.join(", ")}) with no review verdict for its patch: land.ts lands it only with a reviewer's, or with this run's for a repair of the lint and format fixers alone`,
    };
  }

  if (risky.length > 0 && verdict.kind === "red") {
    return {
      owner: "human",
      why: `is red on ${sha}, whose patch carries a review verdict: an agent commit would void it`,
    };
  }

  if (risky.length > 0) return { owner: "agent", reasons: ["vouched"] };

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
      `${pr.headRefName} is at ${short(fetched)} on origin, not ${short(pr.headRefOid)} as listed: Renovate moved it; the next run takes the new head`,
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
      `the agent rewrote ${short(pushed)}, the head on origin: the run pushes only a fast-forward`,
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

/** Pushes the worktree's head to the branch under a lease on `pushed`, the head origin holds. */
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

type FixerRound =
  | { readonly kind: "none" }
  | { readonly kind: "pushed"; readonly vouched: boolean }
  | { readonly kind: "human"; readonly why: string };

type Pushed =
  | { readonly kind: "none" }
  | { readonly kind: "human"; readonly why: string }
  | { readonly kind: "pushed"; readonly head: string; readonly patchId: string | null };

async function fixerVersions(run: Run, worktree: string, log: number): Promise<FixerVersions> {
  const read = async (tool: FixerTool) => {
    const version = await streamed(["bun", "x", tool, "--version"], worktree, log, run.progress);

    if (version.code !== 0) {
      throw new Error(
        `bun x ${tool} --version exited ${version.code}: ${lastNonEmptyLine(version.output)}`,
      );
    }

    return versionOf(version.output);
  };

  return { oxfmt: await read("oxfmt"), oxlint: await read("oxlint") };
}

/**
 * Rebases the branch onto `base`, runs the fixers and commits and pushes what they change, when the run may vouch
 * for it or it needs no verdict. Every other way out, a throw included, leaves the worktree clean at the listed head,
 * so `heldWork` does not stop the next runs.
 */
async function commitFixes(
  run: Run,
  pr: RenovatePr,
  worktree: string,
  { log, versions, base }: { log: number; versions: FixerVersions; base: string },
): Promise<Pushed> {
  const restore = () => {
    command(["git", "rebase", "--abort"], worktree);
    git(worktree, "reset", "--quiet", "--hard", pr.headRefOid);
    git(worktree, "clean", "--quiet", "-fd");
  };

  const drop = (why: string): Pushed => {
    restore();
    writeSync(log, `the fixers' change is dropped: ${why}; the agent round follows\n`);

    return { kind: "none" };
  };

  try {
    const rebase = await streamed(["git", "rebase", "--quiet", BASE], worktree, log, run.progress);

    checkStop(run.progress);

    if (rebase.code !== 0) {
      if (SIGNING_FAILED.test(rebase.output)) {
        throw new Error(`git rebase ${BASE}: ${lastNonEmptyLine(rebase.output)}`);
      }

      return drop(`${pr.headRefName} does not rebase cleanly on ${BASE}`);
    }

    for (const step of FIXER_STEPS) {
      const ran = await streamed(step.args, worktree, log, run.progress);

      checkStop(run.progress);
      const failure = fixerFailure(step.tool, ran.code, ran.output);

      if (failure !== null) return drop(failure);
    }

    const fixed = git(worktree, "diff", "--name-only", "--no-renames", "-z")
      .split("\0")
      .filter((path) => path !== "");

    if (fixed.length === 0) {
      restore();

      return { kind: "none" };
    }

    git(worktree, "add", "--update");

    const hook = await streamed(
      ["git", "hook", "run", "--ignore-missing", "pre-commit"],
      worktree,
      log,
      run.progress,
    );

    checkStop(run.progress);

    if (hook.code !== 0) return drop(`the pre-commit hook exited ${hook.code}`);

    const commit = await streamed(
      ["git", "commit", "--quiet", "-m", fixerCommitMessage(versions, pr.headRefOid, base)],
      worktree,
      log,
      run.progress,
    );

    checkStop(run.progress);

    if (commit.code !== 0) {
      throw new Error(`git commit exited ${commit.code}: ${lastNonEmptyLine(commit.output)}`);
    }

    const head = git(worktree, "rev-parse", "HEAD");

    const under = git(worktree, "log", "--format=%H%x09%ae", `${BASE}..HEAD^`)
      .split("\n")
      .filter((line) => line !== "")
      .map((line): BranchCommit => {
        const [sha = "", author = ""] = line.split("\t");

        return { sha, author };
      });

    const renovatePaths = git(
      worktree,
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      `${BASE}...HEAD^`,
    )
      .split("\0")
      .filter((path) => path !== "");

    const verdict = fixerVerdict({ under, renovatePaths, fixed, isRisky: riskyPaths(run.main) });

    if (verdict.kind === "human") {
      restore();

      return verdict;
    }

    let patchId: string | null = null;

    if (verdict.kind === "record") {
      const read = patchIdOf(worktree, BASE, head);

      if (read.kind === "failed") throw new Error(read.why);

      patchId = read.id;
    }

    const push = await pushHead(run, pr, worktree, pr.headRefOid, log);

    if (push.code !== 0) {
      throw new Error(`git push exited ${push.code}: ${lastNonEmptyLine(push.output)}`);
    }

    return { kind: "pushed", head, patchId };
  } catch (error) {
    restore();
    throw error;
  }
}

/**
 * The fixers' round, before the first agent round on a red branch: oxfmt, `oxlint --fix` and oxfmt again at the
 * versions the update installed, on the branch rebased onto `origin/dev`, as CI lints it. A repair touching a risky
 * path is pushed only when the run vouches for it, with the verdict `land.ts` reads, which says no review was made.
 */
async function fixerRound(
  run: Run,
  pr: RenovatePr,
  worktree: string,
  { log, settled }: { log: number; settled: Settled },
): Promise<FixerRound> {
  const versions = await fixerVersions(run, worktree, log);

  git(run.main, "fetch", "--quiet", "origin", `+refs/heads/${DEV}:refs/remotes/${BASE}`);
  const base = git(worktree, "rev-parse", BASE);
  const pushed = await commitFixes(run, pr, worktree, { log, versions, base });

  if (pushed.kind !== "pushed") return pushed;

  settled.heads.push(pr.headRefOid, pushed.head);

  if (pushed.patchId === null) return { kind: "pushed", vouched: false };

  const posted = postVerdict(
    worktree,
    pr.number,
    pushed.patchId,
    fixerVerdictWhy(versions, pr.headRefOid, base),
  );

  if (posted.kind === "refused") throw new Error(posted.why);

  writeSync(log, `recorded the fixers' verdict on #${pr.number}: patch-id ${pushed.patchId}\n`);

  return { kind: "pushed", vouched: true };
}

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

    let vouched = reasons.includes("vouched");

    if (why !== null) {
      const fixers = await fixerRound(run, pr, worktree, { log, settled });

      if (fixers.kind === "human") {
        git(run.main, "worktree", "remove", "--force", worktree);

        return { kind: "human", pr, why: fixers.why };
      }

      if (fixers.kind === "pushed") {
        why = null;
        vouched = fixers.vouched;
      }
    }

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

      if (vouched) {
        return {
          kind: "failed",
          pr,
          reason: `CI is red on a head whose patch carries a review verdict: an agent commit would void it (${verdict})`,
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
  const profile = riskyOf(cwd, BASE);

  if (profile.kind === "unreadable") return () => true;

  const globs = profile.risky.map((glob) => new Bun.Glob(glob));

  return (path) => globs.some((glob) => glob.match(path));
}

/** Whether a verdict on `pr`, by someone who can push, names its risky head's patch, the one `land.ts` matches. */
function vouchedFor(cwd: string, pr: RenovatePr, isRisky: RiskyPath): boolean {
  if (!pr.files.some((path) => isRisky(path))) return false;

  const patchId = patchIdOf(cwd, BASE, pr.headRefOid);

  if (patchId.kind === "failed") return false;

  // SAFETY: the shape `--json comments` asks gh for.
  const { comments } = JSON.parse(
    gh(cwd, "pr", "view", String(pr.number), "--json", "comments"),
  ) as {
    comments: Comment[];
  };

  return verdictsOf(comments).has(patchId.id);
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
        classification: classify(
          pr,
          combinedVerdict(pullRequest, push),
          handled,
          isRisky,
          vouchedFor(cwd, pr, isRisky),
        ),
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
