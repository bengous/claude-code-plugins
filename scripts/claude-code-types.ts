#!/usr/bin/env bun

/**
 * vellum's copy of the Claude Code plugin API, kept in step with the installed
 * Claude Code away from the developer's session.
 *
 *   bun ./scripts/claude-code-types.ts run          # the pipeline; the SessionStart hook starts it detached
 *   bun ./scripts/claude-code-types.ts regenerate   # rewrite the two files in this checkout from the installed build
 *
 * `run` works in its own worktree, `<main worktree>.wt/claude-code-types`, on
 * the rolling branch `chore/claude-code-types`. The branch is live while its
 * pull request is open: the run then rebases it onto `origin/dev`, and
 * otherwise starts it again from `origin/dev`. The run installs the
 * dependencies, regenerates and commits the types, hands the worktree to a
 * headless Claude that judges the update's impact on the hooks modules and
 * commits what the update calls for, then pushes the branch and opens or
 * updates its pull request to `dev`. Its lock, log, last outcome and the
 * version it last settled live in `<git common dir>/claude-code-types/`,
 * where the hook reads them at session start: the run alone decides whether
 * a version needs work, after its fetch.
 *
 * An interactive Claude Code session writes a mod's types into its
 * `.claude-plugin/types/` as it loads it with `--plugin-dir`; a `-p` run does
 * not. `regenerate` loads an empty mod from a temp directory in such a session
 * and copies back the core and the tools; the MCP file describes a session's
 * own servers.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Subprocess } from "bun";

import { isE2ePath } from "./check-e2e-green.ts";
import { TOOLS_TYPES_PATH, TYPES_PATH } from "./lib/claude-code-types-paths.ts";
import {
  command,
  commonDirOf,
  gh,
  git,
  heldWork,
  lastLine,
  logged,
  notify,
  probeSigning,
  promptFor,
  SIGNING_FAILED,
  STOP_SIGNALS,
  takeRunLock,
  worktreesOf,
  writeWhole,
} from "./lib/headless-run.ts";
import { hooksModulePlugins } from "./lib/hooks-modules.ts";

export const ROLLING_BRANCH = "chore/claude-code-types";

export const BASE = "origin/dev";

export const ROLLING_REMOTE = `origin/${ROLLING_BRANCH}`;

export const RUN_GUARD = "CLAUDE_CODE_TYPES_RUN";

const PROMPT = join(import.meta.dir, "claude-code-types.prompt.md");

const HEADER_PATTERN = /^\/\/ Written by Claude Code (\S+)\.$/u;

const VERSION_PATTERN = /^(\S+) \(Claude Code\)$/u;

const REPORT_LINES = 60;

const EMPTY_MOD = {
  ".claude-plugin/plugin.json": JSON.stringify({ name: "plugin-types", version: "0.0.0" }),
  "hooks/hooks.json": JSON.stringify({ modules: ["./register.js"] }),
  "hooks/register.js": "export function register() {}\n",
} as const;

const INHERITED_VARIABLES = ["PATH", "HOME"];

const TYPES_WAIT_MS = 60_000;

const TYPES_POLL_MS = 100;

const SCREEN_LINES = 20;

const STOP_GRACE_MS = 2_000;

const INSTALLS = [
  ["bun", "install", "--frozen-lockfile"],
  ["bun", "install", "--cwd", "vellum", "--frozen-lockfile"],
  ["bun", "install", "--cwd", "pinpoint", "--frozen-lockfile"],
  ["bun", "install", "--cwd", "atlas", "--frozen-lockfile"],
] as const;

export type Step =
  | "fetch"
  | "sign"
  | "worktree"
  | "install"
  | "regenerate"
  | "agent"
  | "verify"
  | "push"
  | "pr";

/** The installed build, the trunk's types and the live rolling branch's, null when no pull request is open. */
export interface Versions {
  installed: string;
  devHeader: string;
  rollingHeader: string | null;
}

export type Outcome =
  | { kind: "pr"; url: string; from: string; to: string; created: boolean }
  | ({ kind: "skipped" } & Versions)
  | {
      kind: "failed";
      to: string;
      step: Step;
      reason: string;
      log: string;
      worktree: string | null;
    }
  | {
      kind: "stopped";
      to: string;
      step: Step;
      signal: string;
      log: string;
      worktree: string | null;
    };

/** The run that holds the lock, and the version it works for: what a session start shows of it. */
export interface Holder {
  pid: number;
  startedAt: string;
  version: string;
}

export interface StatePaths {
  dir: string;
  lock: string;
  holder: string;
  outcome: string;
  settled: string;
  spawnLog: string;
  body: string;
}

/** From the agent on, a failure has spent the run's cost: retrying it at every session would spend it again. */
const SETTLING_STEPS: ReadonlySet<Step> = new Set(["agent", "verify", "push", "pr"]);

interface OpenPullRequest {
  number: number;
  url: string;
  body: string;
}

export function headerVersion(firstLine: string): string {
  const version = HEADER_PATTERN.exec(firstLine)?.[1];

  if (version === undefined) {
    throw new Error(
      `${TYPES_PATH}: expected "// Written by Claude Code <version>." on line 1, found: ${firstLine}`,
    );
  }

  return version;
}

export function installedVersion(versionOutput: string): string {
  const version = VERSION_PATTERN.exec(versionOutput.trim())?.[1];

  if (version === undefined) {
    throw new Error(`\`claude --version\` printed an unknown format: ${versionOutput.trim()}`);
  }

  return version;
}

/** True when the installed build is newer than both the trunk's types and the rolling branch's. */
export function needsRun({ installed, devHeader, rollingHeader }: Versions): boolean {
  return (
    Bun.semver.order(installed, devHeader) === 1 &&
    (rollingHeader === null || Bun.semver.order(installed, rollingHeader) === 1)
  );
}

export function statePaths(commonDir: string): StatePaths {
  const dir = join(commonDir, "claude-code-types");

  return {
    dir,
    lock: join(dir, "run.lock"),
    holder: join(dir, "holder.json"),
    outcome: join(dir, "outcome.json"),
    settled: join(dir, "settled"),
    spawnLog: join(dir, "spawn.log"),
    body: join(dir, "pr-body.md"),
  };
}

/** One log per version: a run for the next version leaves the last one's log alone. */
export function logPath(state: StatePaths, version: string): string {
  return join(state.dir, `${version}.log`);
}

/**
 * True when no session start runs the outcome's version again: published,
 * nothing to do, stopped by hand, or failed once costly.
 */
export function settles(outcome: Outcome): boolean {
  return outcome.kind !== "failed" || SETTLING_STEPS.has(outcome.step);
}

function rerunHint(worktree: string | null): string {
  const keep =
    worktree === null
      ? ""
      : `keep what you need from ${worktree}, which the run refuses to recreate while it holds work, then `;

  return `No session retries it; ${keep}rerun from the main checkout:${worktree === null ? "" : ` git worktree remove --force ${worktree} &&`} bun ./scripts/claude-code-types.ts run`;
}

export function outcomeLine(outcome: Outcome): string {
  switch (outcome.kind) {
    case "pr":
      return `Claude Code types ${outcome.from} → ${outcome.to}: pull request ${outcome.created ? "opened" : "updated"}, ${outcome.url}`;
    case "skipped":
      return `Claude Code types ${outcome.installed}: ${BASE} carries ${outcome.devHeader}, ${ROLLING_BRANCH} ${outcome.rollingHeader ?? "has no open pull request"}; nothing to do.`;
    case "failed":
      return `Claude Code types ${outcome.to}: the run failed at ${outcome.step}: ${outcome.reason} (log: ${outcome.log}). ${settles(outcome) ? rerunHint(outcome.worktree) : "The next session start retries it."}`;
    case "stopped":
      return `Claude Code types ${outcome.to}: the run was stopped by ${outcome.signal} at ${outcome.step} (log: ${outcome.log}). ${rerunHint(outcome.worktree)}`;
  }
}

/** The version in the types header at `ref`, or null when the ref or the file is not there. */
export function refHeader(cwd: string, ref: string): string | null {
  const object = `${ref}:${TYPES_PATH}`;

  if (command(["git", "cat-file", "-e", object], cwd).code !== 0) return null;

  try {
    return headerVersion(git(cwd, "show", object).split(/\r?\n/u, 1)[0] ?? "");
  } catch (error) {
    throw new Error(`${ref}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}

function fileHeader(root: string): string {
  return headerVersion(readFileSync(join(root, TYPES_PATH), "utf8").split(/\r?\n/u, 1)[0] ?? "");
}

/** The version the last settling run ended for, which no session start runs again. */
export function settledVersion(file: string): string | null {
  return existsSync(file) ? readFileSync(file, "utf8").trim() : null;
}

/** How the session ended on its own, or null while it runs. */
function sessionEnd(session: Subprocess): string | null {
  if (session.exitCode !== null) return `exited ${session.exitCode}`;

  if (session.signalCode !== null) return `was killed by ${session.signalCode}`;

  return null;
}

/** Stops the session, with SIGKILL when it outlives SIGTERM by the grace. */
async function stopSession(session: Subprocess): Promise<void> {
  session.kill("SIGTERM");

  let grace: ReturnType<typeof setTimeout> | undefined;

  const ended = await Promise.race([
    session.exited.then(() => true),
    new Promise<false>((resolve) => {
      grace = setTimeout(() => resolve(false), STOP_GRACE_MS);
    }),
  ]);

  clearTimeout(grace);

  if (!ended) {
    session.kill("SIGKILL");
    await session.exited;
  }

  session.terminal?.close();
}

/**
 * Rewrites the two files from the installed build; the session it starts is
 * `progress.child` while it runs, so a run's stop reaches it, and the wait
 * for the files ends with `progress.signal`.
 */
export async function regenerate(
  root: string,
  progress: Pick<Progress, "child" | "signal">,
): Promise<void> {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "plugin-types-")));
  const mod = join(scratch, "mod");
  const config = join(scratch, "config");
  const written = join(mod, ".claude-plugin", "types");
  const core = join(written, "claude-code", "index.d.ts");
  const tools = join(written, "claude-code-tools", "index.d.ts");

  const bothWritten = async () =>
    (await Bun.file(core).exists()) && (await Bun.file(tools).exists());

  try {
    for (const [path, content] of Object.entries(EMPTY_MOD)) {
      await mkdir(join(mod, path, ".."), { recursive: true });
      await writeFile(join(mod, path), content);
    }

    // A `-p` run given no prompt loads the mod but stops before it writes the
    // types, so they come from an interactive session in a terminal of its
    // own, stopped once both files are there: the engine renames each into
    // place whole, and a session given no prompt never reaches a model. Its
    // config only marks the onboarding done and the scratch directory
    // trusted, so the session reaches its prompt without a login. The tool
    // types follow the environment and the account: that config and only PATH
    // and HOME make them the build's own. HOME reaches the installed build, so
    // the session's updater is off. The scratch directory holds no settings,
    // so the session's own SessionStart reaches no hook.
    await mkdir(config);

    await writeFile(
      join(config, ".claude.json"),
      JSON.stringify({
        hasCompletedOnboarding: true,
        projects: { [scratch]: { hasTrustDialogAccepted: true } },
      }),
    );

    const env = Object.fromEntries([
      ...Object.entries(process.env).filter(([name]) => INHERITED_VARIABLES.includes(name)),
      ["CLAUDE_CONFIG_DIR", config],
      ["DISABLE_AUTOUPDATER", "1"],
    ]);

    const decoder = new TextDecoder();

    let screen = "";

    const session = Bun.spawn(["claude", "--setting-sources", "project", "--plugin-dir", mod], {
      cwd: scratch,
      env,
      terminal: {
        data: (_terminal, data) => {
          screen += decoder.decode(data, { stream: true });
        },
      },
    });

    const deadline = Date.now() + TYPES_WAIT_MS;

    let end: string;

    progress.child = session;

    try {
      while (
        progress.signal === null &&
        sessionEnd(session) === null &&
        Date.now() < deadline &&
        !(await bothWritten())
      )
        await Bun.sleep(TYPES_POLL_MS);

      end =
        sessionEnd(session) ??
        (progress.signal === null
          ? `ran ${TYPES_WAIT_MS / 1000} s`
          : `was stopped by ${progress.signal}`);
      await stopSession(session);
    } finally {
      progress.child = null;
    }

    if (!(await bothWritten())) {
      const output = Bun.stripANSI(screen)
        .split(/\r\n|\r|\n/u)
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .slice(-SCREEN_LINES)
        .join(" | ");

      throw new Error(`claude --plugin-dir ${end} without writing the mod's types: ${output}`);
    }

    await copyFile(core, join(root, TYPES_PATH));
    await copyFile(tools, join(root, TOOLS_TYPES_PATH));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Where `run` recreates its worktree, removing a clean one it finds there. */
export async function worktreePath(cwd: string): Promise<string> {
  return `${(await worktreesOf(cwd)).main}.wt/claude-code-types`;
}

/**
 * Recreates the worktree on the rolling branch: the live branch rebased onto
 * the trunk, else the trunk. Answers the live branch's commits when they would
 * not rebase, the worktree then starting again from the trunk.
 */
async function prepareWorktree(cwd: string, path: string, live: boolean): Promise<string> {
  const { checkouts } = await worktreesOf(cwd);
  const holder = checkouts.find((tree) => tree.branch === ROLLING_BRANCH && tree.dir !== path);

  if (holder !== undefined) {
    throw new Error(
      `${ROLLING_BRANCH} is checked out in ${holder.dir}; the run needs it in ${path}`,
    );
  }

  if (checkouts.some((tree) => tree.dir === path)) {
    const work = heldWork(path);

    if (work !== null) {
      throw new Error(
        `${path} holds ${work}; keep what you need, then git worktree remove --force ${path}`,
      );
    }

    git(cwd, "worktree", "remove", "--force", path);
  }

  git(cwd, "worktree", "prune");

  if (existsSync(path)) throw new Error(`${path} exists and is no worktree of this repository`);
  git(cwd, "worktree", "add", "--quiet", "-B", ROLLING_BRANCH, path, live ? ROLLING_REMOTE : BASE);

  if (!live) return "";
  const rebase = command(["git", "rebase", "--quiet", BASE], path);

  if (rebase.code === 0) return "";

  const dropped = git(path, "log", "--format=%h %s", `${BASE}..${ROLLING_REMOTE}`);
  git(path, "rebase", "--abort");

  if (SIGNING_FAILED.test(`${rebase.out}${rebase.err}`)) {
    throw new Error(`git could not sign the rebased commits: ${lastLine(rebase)}`);
  }

  git(path, "reset", "--quiet", "--hard", BASE);

  return dropped;
}

async function install(worktree: string, run: { log: number; progress: Progress }): Promise<void> {
  for (const args of INSTALLS) {
    const code = await logged(args, worktree, run);

    if (code !== 0) throw new Error(`${args.join(" ")} exited ${code}`);
  }
}

/** Commits the regenerated types; answers what the agent is told of that commit. */
function commitTypes(worktree: string, to: string, log: number): string {
  const message = `chore(vellum): types from Claude Code ${to}`;
  git(worktree, "add", TYPES_PATH, TOOLS_TYPES_PATH);
  const commit = command(["git", "commit", "--quiet", "-m", message], worktree);
  const report = `${commit.out}${commit.err}`;
  writeSync(log, report);

  if (commit.code !== 0 && SIGNING_FAILED.test(report)) {
    throw new Error(`git could not sign the types commit: ${lastLine(commit)}`);
  }

  if (commit.code === 0) {
    return `The script committed them as \`${git(worktree, "log", "-1", "--format=%h %s")}\`.`;
  }

  return [
    `The script staged them, and the pre-commit refused their commit \`${message}\`: the update broke something. The end of its report:`,
    "",
    "<pre-commit>",
    report.trimEnd().split("\n").slice(-REPORT_LINES).join("\n"),
    "</pre-commit>",
    "",
    "Fix the break, then commit the fix with the types under that message.",
  ].join("\n");
}

function openPullRequest(cwd: string): OpenPullRequest | null {
  const listed = gh(
    cwd,
    "pr",
    "list",
    "--head",
    ROLLING_BRANCH,
    "--state",
    "open",
    "--json",
    "number,url,body",
  );

  // SAFETY: the shape `--json number,url,body` asks gh for.
  const [open] = JSON.parse(listed) as OpenPullRequest[];

  return open ?? null;
}

function previousNote(open: OpenPullRequest | null): string {
  if (open === null) return "";

  return [
    `The branch's open pull request, ${open.url}, carries the body below. Keep its findings that still hold, and rewrite it for the whole range.`,
    "",
    "<previous-body>",
    open.body,
    "</previous-body>",
  ].join("\n");
}

function droppedNote(dropped: string): string {
  if (dropped === "") return "";

  return [
    `The branch's earlier commits did not rebase onto ${BASE} without conflicts, so the worktree starts again from ${BASE}. They stay on \`${ROLLING_REMOTE}\` until the script pushes; bring back with \`git cherry-pick\` what still holds:`,
    "",
    dropped,
  ].join("\n");
}

function verify(worktree: string, to: string, body: string): void {
  const branch = command(["git", "symbolic-ref", "--quiet", "HEAD"], worktree).out.trim();

  if (branch !== `refs/heads/${ROLLING_BRANCH}`) {
    throw new Error(`the agent left HEAD on ${branch === "" ? "no branch" : branch}`);
  }

  const dirty = git(worktree, "status", "--porcelain");

  if (dirty !== "") {
    throw new Error(`the agent left changes uncommitted: ${dirty.split("\n").join(", ")}`);
  }

  const header = refHeader(worktree, "HEAD");

  if (header !== to) {
    throw new Error(`HEAD carries the types of ${header ?? "no version"}, not ${to}`);
  }

  if (git(worktree, "rev-list", "--count", `${BASE}..HEAD`) === "0") {
    throw new Error(`${ROLLING_BRANCH} carries no commit over ${BASE}`);
  }

  if (!existsSync(body) || readFileSync(body, "utf8").trim() === "") {
    throw new Error(`the agent wrote no pull request body at ${body}`);
  }
}

/**
 * Where a run stands, read when it ends: the step it was in, the worktree it
 * made, the signal that asked it to stop, and the child that signal reaches.
 */
interface Progress {
  step: Step;
  worktree: string | null;
  signal: NodeJS.Signals | null;
  child: Subprocess | null;
}

/** Opens the pull request, or updates the open one; answers its URL. */
function publish(worktree: string, open: OpenPullRequest | null, to: string, body: string): string {
  const title = `chore(vellum): types from Claude Code ${to}`;
  let url = open?.url;

  if (open === null) {
    const created = gh(
      worktree,
      "pr",
      "create",
      "--base",
      "dev",
      "--head",
      ROLLING_BRANCH,
      "--title",
      title,
      "--body-file",
      body,
    );

    url = created.split("\n").at(-1);
  } else {
    gh(worktree, "pr", "edit", String(open.number), "--title", title, "--body-file", body);
  }

  if (url === undefined || url === "") throw new Error("gh pr create printed no URL");

  const changed = git(worktree, "diff", "--name-only", `${BASE}...HEAD`).split("\n");

  if (changed.some((path) => isE2ePath(path))) {
    gh(worktree, "pr", "edit", url, "--add-label", "e2e");
  }

  return url;
}

interface Run {
  cwd: string;
  installed: string;
  state: StatePaths;
  log: number;
  progress: Progress;
}

async function pipeline(run: Run): Promise<Outcome> {
  const { cwd, installed, state, log, progress } = run;

  const enter = (step: Step) => {
    if (progress.signal !== null) throw new Error(`stopped by ${progress.signal}`);
    progress.step = step;
    writeSync(log, `== ${step}\n`);
  };

  enter("fetch");
  git(cwd, "fetch", "--quiet", "--prune", "origin");
  const devHeader = refHeader(cwd, BASE);

  if (devHeader === null) throw new Error(`${BASE} carries no ${TYPES_PATH}`);

  if (!needsRun({ installed, devHeader, rollingHeader: null })) {
    return { kind: "skipped", installed, devHeader, rollingHeader: null };
  }

  const open = openPullRequest(cwd);
  const rollingHeader = open === null ? null : refHeader(cwd, ROLLING_REMOTE);
  const versions = { installed, devHeader, rollingHeader };

  if (!needsRun(versions)) return { kind: "skipped", ...versions };

  enter("sign");
  probeSigning(cwd);

  enter("worktree");
  const worktree = await worktreePath(cwd);
  const dropped = await prepareWorktree(cwd, worktree, rollingHeader !== null);
  progress.worktree = worktree;

  enter("install");
  await install(worktree, run);

  enter("regenerate");
  await regenerate(worktree, progress);
  const written = fileHeader(worktree);

  if (written !== installed) {
    throw new Error(`claude wrote the types of ${written}, not ${installed}`);
  }

  const types = commitTypes(worktree, installed, log);

  enter("agent");
  rmSync(state.body, { force: true });

  const prompt = promptFor(
    readFileSync(PROMPT, "utf8"),
    {
      from: devHeader,
      to: installed,
      worktree,
      modules: (await hooksModulePlugins(worktree)).join(", "),
      body: state.body,
      types,
      dropped: droppedNote(dropped),
      previous: previousNote(open),
    },
    PROMPT,
  );

  const agent = await logged(
    ["claude", "-p", "--model", "opus", "--permission-mode", "auto", prompt],
    worktree,
    run,
    { [RUN_GUARD]: "1" },
  );

  if (agent !== 0) throw new Error(`claude -p exited ${agent}`);

  enter("verify");
  verify(worktree, installed, state.body);

  enter("push");

  const pushed = await logged(
    ["git", "push", "--force-with-lease", "origin", ROLLING_BRANCH],
    worktree,
    run,
  );

  if (pushed !== 0) throw new Error(`git push exited ${pushed}; the pre-push report is in the log`);

  enter("pr");
  const url = publish(worktree, open, installed, state.body);
  git(cwd, "worktree", "remove", "--force", worktree);

  return { kind: "pr", url, from: devHeader, to: installed, created: open === null };
}

/** The outcome of a run that threw `reason`: stopped when a signal asked it to, else failed. */
function endOf(reason: string, run: Run, logFile: string): Outcome {
  const { progress } = run;

  const worktree =
    progress.worktree !== null && existsSync(progress.worktree) ? progress.worktree : null;

  if (progress.signal !== null) {
    return {
      kind: "stopped",
      to: run.installed,
      step: progress.step,
      signal: progress.signal,
      log: logFile,
      worktree,
    };
  }

  return {
    kind: "failed",
    to: run.installed,
    step: progress.step,
    reason,
    log: logFile,
    worktree,
  };
}

async function runPipeline(start: string): Promise<void> {
  // Every step runs from the main checkout: a run started inside a worktree it
  // recreates would lose its own working directory.
  const cwd = (await worktreesOf(start)).main;
  process.chdir(cwd);
  const state = statePaths(commonDirOf(cwd));
  const installed = installedVersion(command(["claude", "--version"], cwd).out);
  mkdirSync(state.dir, { recursive: true });

  const holder: Holder = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    version: installed,
  };

  const lock = takeRunLock(state, holder);

  if (lock === null) {
    console.error(`claude-code-types: a live run holds ${state.lock}`);

    return;
  }

  const logFile = logPath(state, installed);
  writeFileSync(logFile, "");
  // Append mode, so the lines of the children that share this descriptor follow each other.
  const log = openSync(logFile, "a");
  const progress: Progress = { step: "fetch", worktree: null, signal: null, child: null };
  const run: Run = { cwd, installed, state, log, progress };

  // The run stops where it stands and ends as stopped; its child, the agent
  // above all, stops with it instead of working on alone.
  const stop = (signal: NodeJS.Signals) => {
    progress.signal ??= signal;
    progress.child?.kill("SIGTERM");
  };

  for (const signal of STOP_SIGNALS) process.on(signal, stop);
  let outcome: Outcome;

  try {
    outcome = await pipeline(run);
  } catch (error) {
    outcome = endOf(error instanceof Error ? error.message : String(error), run, logFile);
  }

  // What a run made before its costly steps is its own to throw away, so the
  // retry the next session start makes finds no worktree holding work.
  if (outcome.kind === "failed" && !settles(outcome) && outcome.worktree !== null) {
    git(cwd, "worktree", "remove", "--force", outcome.worktree);
    outcome = { ...outcome, worktree: null };
  }

  writeSync(log, `${outcomeLine(outcome)}\n`);
  writeWhole(state.outcome, JSON.stringify(outcome));

  if (settles(outcome)) writeFileSync(state.settled, installed);

  if (outcome.kind === "pr" || (outcome.kind === "failed" && settles(outcome))) {
    notify("Claude Code types", outcomeLine(outcome), outcome.kind === "failed", log);
  }

  closeSync(log);
  rmSync(state.holder, { force: true });
  closeSync(lock);
}

if (import.meta.main) {
  const action = process.argv[2];

  if (process.argv.length !== 3 || (action !== "run" && action !== "regenerate")) {
    console.error("Usage: bun ./scripts/claude-code-types.ts <run|regenerate>");
    process.exitCode = 2;
  } else {
    try {
      if (action === "run") await runPipeline(process.cwd());
      else
        await regenerate(git(process.cwd(), "rev-parse", "--show-toplevel"), {
          child: null,
          signal: null,
        });
    } catch (error) {
      console.error(`claude-code-types: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
}
