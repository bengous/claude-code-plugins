#!/usr/bin/env bun

/**
 * Lands the Renovate pull requests that Renovate does not merge by itself.
 *
 *   bun ./scripts/renovate-agent.ts run             # the SessionStart hook starts it detached, once a day
 *   bun ./scripts/renovate-agent.ts run --dry-run   # print each open pull request's owner; start nothing
 *
 * Renovate merges a non-major update that touches no e2e path itself, by
 * branch automerge, once CI is green on its branch (`renovate.json`). This run
 * owns the others among the open Renovate pull requests against `dev` whose
 * `ci.yml` runs have concluded: a red one, a major (Renovate's `major` label),
 * and one whose files touch the e2e paths (`isE2ePath`). A head this run
 * already handled is left until Renovate pushes another.
 *
 * Each owned pull request gets its own worktree, `<main worktree>.wt/
 * renovate/<number>`, with the dependencies installed. A red one is handed
 * first to a headless Claude (`scripts/renovate-agent.prompt.md`) that commits
 * the repair, signed with the user's key; the run pushes the commits and runs
 * `scripts/land.ts`, which waits for CI, runs the e2e suite when the branch
 * needs it and lands the branch on `dev`. A landing refused gets one more
 * agent round with the refusal, then is reported. Each end, landed or not, is
 * a line the next session start shows and a desktop notice. The lock, the
 * logs, the handled heads and the lines not yet shown live in `<git common
 * dir>/renovate-agent/`.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";

import { isE2ePath } from "./check-e2e-green.ts";
import { type CiVerdict, ciVerdict, ghCli } from "./ci-wait.ts";
import { RUN_GUARD as TYPES_RUN_GUARD } from "./claude-code-types.ts";
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

export const MAJOR_LABEL = "major";

const RENOVATE_AUTHOR = "app/renovate";

const DEV = "dev";

const PROMPT = join(import.meta.dir, "renovate-agent.prompt.md");

const NOTICE = "Renovate agent";

/** Agent rounds per pull request: the first repair, and one more for a landing refused after it. */
const AGENT_ROUNDS = 2;

const CANNOT_REPAIR = /^CANNOT REPAIR:.*$/mu;

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
  | { readonly owner: "wait"; readonly why: string }
  | { readonly owner: "handled"; readonly why: string };

export type PrOutcome =
  | { readonly kind: "landed"; readonly pr: RenovatePr; readonly verdict: string }
  | {
      readonly kind: "failed";
      readonly pr: RenovatePr;
      readonly reason: string;
      readonly log: string;
      readonly worktree: string | null;
    };

export interface StatePaths extends LockPaths {
  readonly dir: string;
  readonly day: string;
  readonly handled: string;
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
    report: join(dir, "report.json"),
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
 * Who lands `pr`, given its `ci.yml` verdict and the heads already handled.
 * Nobody acts before CI concludes: Renovate would not merge a running branch,
 * and `land.ts` refuses a head with no run.
 */
export function classify(pr: RenovatePr, verdict: CiVerdict, handled: Handled): Classification {
  const sha = shortSha(pr.headRefOid);

  if ((handled[String(pr.number)] ?? []).includes(pr.headRefOid)) {
    return { owner: "handled", why: `${sha} was handled by an earlier run; waits for a new head` };
  }

  if (verdict.kind === "running") return { owner: "wait", why: `CI still runs on ${sha}` };

  if (verdict.kind === "none")
    return { owner: "wait", why: `no ci.yml pull_request run on ${sha}` };

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

  if (outcome.kind === "landed") return `${head}: ${outcome.verdict}`;

  const kept =
    outcome.worktree === null ? "" : `; its worktree, ${outcome.worktree}, is kept as it is`;

  return `${head} needs you: ${outcome.reason} (log: ${outcome.log}${kept}). ${outcome.pr.url}`;
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

/** Adds `lines` to those the next session start shows. */
function report(file: string, lines: readonly string[]): void {
  // SAFETY: only this run writes the file, whole, from a string array; the hook takes it whole.
  const pending = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as string[]) : [];
  writeWhole(file, JSON.stringify([...pending, ...lines]));
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

/** A fresh worktree on the pull request's branch at its remote head. */
async function prepareWorktree(run: Run, pr: RenovatePr, path: string): Promise<void> {
  const { checkouts } = await worktreesOf(run.main);
  const holder = checkouts.find((tree) => tree.branch === pr.headRefName && tree.dir !== path);

  if (holder !== undefined) {
    throw new Error(
      `${pr.headRefName} is checked out in ${holder.dir}; the run needs it in ${path}`,
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

  git(
    run.main,
    "worktree",
    "add",
    "--quiet",
    "-B",
    pr.headRefName,
    path,
    `origin/${pr.headRefName}`,
  );
}

function verifyAgentLeft(worktree: string, branch: string): void {
  const head = command(["git", "symbolic-ref", "--quiet", "HEAD"], worktree).out.trim();

  if (head !== `refs/heads/${branch}`) {
    throw new Error(`the agent left HEAD on ${head === "" ? "no branch" : head}`);
  }

  const dirty = git(worktree, "status", "--porcelain");

  if (dirty !== "") {
    throw new Error(`the agent left changes uncommitted: ${dirty.split("\n").join(", ")}`);
  }
}

async function agentRound(
  run: Run,
  pr: RenovatePr,
  worktree: string,
  why: string,
  log: number,
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

  // The sessions the agent starts leave the types pipeline alone, as its own do.
  const agent = await streamed(
    ["claude", "-p", "--model", "opus", "--permission-mode", "auto", prompt],
    worktree,
    log,
    run.progress,
    { [TYPES_RUN_GUARD]: "1" },
  );

  const cannot = CANNOT_REPAIR.exec(agent.output)?.[0];

  if (cannot !== undefined) throw new Error(`the agent reports ${cannot}`);

  if (agent.code !== 0) throw new Error(`claude -p exited ${agent.code}`);
  verifyAgentLeft(worktree, pr.headRefName);
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
    throw new Error(
      `git push exited ${push.code}: ${lastNonEmptyLine(push.output)}; Renovate may have pushed meanwhile`,
    );
  }
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

    let rounds = 0;

    for (;;) {
      if (why !== null) {
        if (rounds === AGENT_ROUNDS) {
          throw new Error(`still not landed after ${AGENT_ROUNDS} agent rounds: ${why}`);
        }

        rounds += 1;
        await agentRound(run, pr, worktree, why, log);
      }

      const landing = await streamed(
        ["bun", "./scripts/land.ts", pr.headRefName],
        worktree,
        log,
        run.progress,
      );

      const verdict = lastNonEmptyLine(landing.output);

      if (landing.code === 0) {
        git(run.main, "worktree", "remove", "--force", worktree);

        return { kind: "landed", pr, verdict };
      }

      why = `\`bun ./scripts/land.ts ${pr.headRefName}\` refused it: ${verdict}`;
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    writeSync(log, `${reason}\n`);

    return {
      kind: "failed",
      pr,
      reason,
      log: logFile,
      worktree: made && existsSync(worktree) ? worktree : null,
    };
  } finally {
    closeSync(log);
  }
}

function classifyAll(
  cwd: string,
  handled: Handled,
): Promise<readonly { pr: RenovatePr; classification: Classification }[]> {
  const prs = listPrs(cwd);

  return Promise.all(
    prs.map(async (pr) => ({
      pr,
      classification: classify(
        pr,
        await ciVerdict((args) => ghCli(args, cwd), { sha: pr.headRefOid, event: "pull_request" }),
        handled,
      ),
    })),
  );
}

async function dryRun(start: string): Promise<void> {
  const { main } = await worktreesOf(start);
  const state = statePaths(commonDirOf(main));

  for (const { pr, classification } of await classifyAll(main, readHandled(state.handled))) {
    console.log(classificationLine(pr, classification));
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
    run.progress.child?.kill("SIGTERM");
  };

  for (const signal of STOP_SIGNALS) process.on(signal, stop);

  try {
    git(main, "fetch", "--quiet", "--prune", "origin");
    const handled = readHandled(state.handled);
    const classified = await classifyAll(main, handled);

    for (const { pr, classification } of classified) {
      writeSync(log, `${classificationLine(pr, classification)}\n`);
    }

    const owned = classified.flatMap(({ pr, classification }) =>
      classification.owner === "agent" ? [{ pr, reasons: classification.reasons }] : [],
    );

    if (owned.length > 0) probeSigning(main);
    const added: Record<string, string[]> = {};

    for (const { pr, reasons } of owned) {
      const outcome = await handle(run, pr, reasons);
      const after = command(["git", "ls-remote", "origin", `refs/heads/${pr.headRefName}`], main);
      const remoteHead = after.out.split("\t")[0] ?? "";

      added[String(pr.number)] = [pr.headRefOid, ...(remoteHead === "" ? [] : [remoteHead])];
      const line = outcomeLine(outcome);
      writeSync(log, `${line}\n`);
      report(state.report, [line]);
      notify(NOTICE, line, outcome.kind === "failed", log);

      writeWhole(
        state.handled,
        JSON.stringify(
          recordHandled(
            readHandled(state.handled),
            classified.map(({ pr: open }) => open.number),
            added,
          ),
        ),
      );
    }
  } catch (error) {
    const line = `Renovate agent: the run failed: ${error instanceof Error ? error.message : String(error)} (log: ${state.runLog})`;
    writeSync(log, `${line}\n`);
    report(state.report, [line]);
    notify(NOTICE, line, true, log);
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
