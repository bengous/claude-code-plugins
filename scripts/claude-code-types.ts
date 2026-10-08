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
 * Claude Code writes a mod's types into its `.claude-plugin/types/` as it
 * loads it with `--plugin-dir`. `regenerate` loads an empty mod from a temp
 * directory and copies back the core and the tools; the MCP file describes a
 * session's own servers.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { $, type Subprocess } from "bun";

import { isE2ePath } from "./check-e2e-green.ts";
import { tryLock, unlock } from "./lib/flock.ts";
import { hooksModulePlugins } from "./lib/hooks-modules.ts";
import { pluginDirAt, readWorktrees } from "./lib/plugin-sources.ts";

export const TYPES_PATH = "vellum/types/claude-code.d.ts";

export const TOOLS_TYPES_PATH = "vellum/types/claude-code-tools.d.ts";

export const ROLLING_BRANCH = "chore/claude-code-types";

export const BASE = "origin/dev";

export const ROLLING_REMOTE = `origin/${ROLLING_BRANCH}`;

export const RUN_GUARD = "CLAUDE_CODE_TYPES_RUN";

const PROMPT = join(import.meta.dir, "claude-code-types.prompt.md");

const HEADER_PATTERN = /^\/\/ Written by Claude Code (\S+)\.$/u;

const VERSION_PATTERN = /^(\S+) \(Claude Code\)$/u;

const LOCK_TRIES = 10;

const LOCK_PAUSE_MS = 100;

const REPORT_LINES = 60;

// git's words when gpg cannot sign ("error: gpg failed to sign the data:");
// probeSigning catches every format before the first commit.
const SIGNING_FAILED = /gpg failed to sign the data/u;

const EMPTY_MOD = {
  ".claude-plugin/plugin.json": JSON.stringify({ name: "plugin-types", version: "0.0.0" }),
  "hooks/hooks.json": JSON.stringify({ modules: ["./register.js"] }),
  "hooks/register.js": "export function register() {}\n",
} as const;

const INHERITED_VARIABLES = ["PATH", "HOME"];

const INSTALLS = [
  ["bun", "install", "--frozen-lockfile"],
  ["bun", "install", "--cwd", "vellum", "--frozen-lockfile"],
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

/** A run holds the lock; its holder is null for the instant between its lock and its holder file. */
export type RunState = { kind: "idle" } | { kind: "running"; holder: Holder | null };

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

interface Result {
  code: number;
  out: string;
  err: string;
}

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

/** Fills each `{{name}}` of the template; a name without a value is a typo, refused. */
export function promptFor(template: string, values: Readonly<Record<string, string>>): string {
  return template.replaceAll(/\{\{(\w+)\}\}/gu, (_, name: string) => {
    const value = values[name];

    if (value === undefined) throw new Error(`${PROMPT}: no value for {{${name}}}`);

    return value;
  });
}

/** A command's result; a binary missing from PATH answers 127, as a shell does. */
function command(args: readonly string[], cwd: string): Result {
  try {
    const result = Bun.spawnSync([...args], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
  } catch (error) {
    return {
      code: 127,
      out: "",
      err: `${args[0]}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function git(cwd: string, ...args: string[]): string {
  const result = command(["git", ...args], cwd);

  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")}: ${`${result.err}${result.out}`.trim()}`);
  }

  return result.out.trimEnd();
}

function gh(cwd: string, ...args: string[]): string {
  const result = command(["gh", ...args], cwd);

  if (result.code !== 0) throw new Error(`gh ${args.join(" ")}: ${result.err.trim()}`);

  return result.out.trim();
}

export function commonDirOf(cwd: string): string {
  return git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");
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

/** Writes `content` beside `file`, then renames it into place, so a reader never meets it half-written. */
function writeWhole(file: string, content: string): void {
  const draft = `${file}.${process.pid}`;
  writeFileSync(draft, content);
  renameSync(draft, file);
}

/**
 * Whether a run holds the lock: a shared lock taken for an instant tells,
 * the kernel answering for the holder, alive or not.
 */
export function runState(state: StatePaths): RunState {
  if (!existsSync(state.lock)) return { kind: "idle" };
  const fd = openSync(state.lock, "r");

  try {
    if (tryLock(fd, "shared")) {
      unlock(fd);

      return { kind: "idle" };
    }

    // SAFETY: only takeRunLock writes this file, whole, from a Holder.
    const holder = existsSync(state.holder)
      ? (JSON.parse(readFileSync(state.holder, "utf8")) as Holder)
      : null;

    return { kind: "running", holder };
  } finally {
    closeSync(fd);
  }
}

/**
 * Takes the run's lock for `version`: the descriptor the run keeps open until
 * it exits, null while another run holds the lock. The file itself is never
 * removed: a run that opened it before the removal and one that created it
 * after would each hold a lock of their own.
 */
function takeRunLock(state: StatePaths, version: string): number | null {
  const fd = openSync(state.lock, "a");

  // A session start's check holds the lock shared for an instant.
  for (let tries = 1; !tryLock(fd, "exclusive"); tries++) {
    if (tries === LOCK_TRIES) {
      closeSync(fd);

      return null;
    }

    Bun.sleepSync(LOCK_PAUSE_MS);
  }

  const holder: Holder = { pid: process.pid, startedAt: new Date().toISOString(), version };
  writeWhole(state.holder, JSON.stringify(holder));

  return fd;
}

export async function regenerate(root: string): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), "plugin-types-"));
  const mod = join(scratch, "mod");
  const config = join(scratch, "config");
  const written = join(mod, ".claude-plugin", "types");
  const core = join(written, "claude-code", "index.d.ts");
  const tools = join(written, "claude-code-tools", "index.d.ts");

  try {
    for (const [path, content] of Object.entries(EMPTY_MOD)) {
      await mkdir(join(mod, path, ".."), { recursive: true });
      await writeFile(join(mod, path), content);
    }

    await mkdir(config);

    // Claude Code writes the types before it asks for a prompt, so a run
    // given none stops there and never reaches a model, whatever the login.
    // The tool types follow the environment and the account: an empty config
    // and only PATH and HOME make them the build's own. The scratch directory
    // holds no settings, so the run's own SessionStart reaches no hook.
    const env = Object.fromEntries([
      ...Object.entries(process.env).filter(([name]) => INHERITED_VARIABLES.includes(name)),
      ["CLAUDE_CONFIG_DIR", config],
    ]);

    const run =
      await $`claude -p --setting-sources project --no-session-persistence --plugin-dir ${mod} < /dev/null`
        .cwd(scratch)
        .env(env)
        .nothrow()
        .quiet();

    if (!(await Bun.file(core).exists()) || !(await Bun.file(tools).exists())) {
      const output = `${run.stderr.toString()}\n${run.stdout.toString()}`
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .join(" | ");

      throw new Error(
        `claude -p --plugin-dir exited ${run.exitCode} without writing the mod's types: ${output}`,
      );
    }

    await copyFile(core, join(root, TYPES_PATH));
    await copyFile(tools, join(root, TOOLS_TYPES_PATH));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function worktreesOf(cwd: string) {
  const root = pluginDirAt(cwd);

  if (root === null) throw new Error(`${cwd} is no directory`);

  return await readWorktrees(root);
}

async function worktreePath(cwd: string): Promise<string> {
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

/** What a worktree holds that its remote does not: changes, or commits pushed nowhere; null when nothing. */
function heldWork(path: string): string | null {
  const changes = git(path, "status", "--porcelain");

  if (changes !== "") return `uncommitted changes (${changes.split("\n").length})`;
  const unpushed = git(path, "rev-list", "--count", "HEAD", "--not", "--remotes=origin");

  return unpushed === "0" ? null : `${unpushed} commits pushed nowhere`;
}

function lastLine({ out, err }: Result): string {
  return (
    `${out}${err}`
      .trimEnd()
      .split("\n")
      .findLast((line) => line.trim() !== "") ?? ""
  );
}

/**
 * Fails fast when commits cannot be signed: a locked key would otherwise fail
 * the types commit as a pre-commit refusal, and every commit of the agent
 * after it. The probe signs nothing it keeps, and never asks for a
 * passphrase: a detached run has nobody to type it.
 */
function probeSigning(cwd: string): void {
  if (command(["git", "config", "--bool", "commit.gpgsign"], cwd).out.trim() !== "true") return;
  const config = (key: string) => command(["git", "config", key], cwd).out.trim();
  const format = config("gpg.format") || "openpgp";

  const probe =
    format === "openpgp"
      ? spawnProbe(cwd, [
          config("gpg.program") || "gpg",
          "--batch",
          "--pinentry-mode",
          "error",
          ...(config("user.signingkey") === "" ? [] : ["--local-user", config("user.signingkey")]),
          "--sign",
          "--output",
          "/dev/null",
        ])
      : command(
          [
            "git",
            "commit-tree",
            "-S",
            "-m",
            "signing probe",
            git(cwd, "hash-object", "-t", "tree", "/dev/null"),
          ],
          cwd,
        );

  if (probe.code !== 0) {
    throw new Error(
      `commits cannot be signed (${lastLine(probe)}): unlock the ${format} key, for instance by signing a commit by hand, and the next session start retries`,
    );
  }
}

function spawnProbe(cwd: string, args: readonly string[]): Result {
  const result = Bun.spawnSync([...args], {
    cwd,
    stdin: new TextEncoder().encode("signing probe\n"),
    stdout: "pipe",
    stderr: "pipe",
  });

  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
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

/** Runs a command with its output appended to the log; answers its exit code. */
async function logged(
  args: readonly string[],
  cwd: string,
  run: { log: number; progress: Progress },
  env: Record<string, string> = {},
): Promise<number> {
  const child = Bun.spawn([...args], {
    cwd,
    env: { ...process.env, ...env },
    stdin: "ignore",
    stdout: run.log,
    stderr: run.log,
  });

  run.progress.child = child;

  try {
    return await child.exited;
  } finally {
    run.progress.child = null;
  }
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
  await regenerate(worktree);
  const written = fileHeader(worktree);

  if (written !== installed) {
    throw new Error(`claude wrote the types of ${written}, not ${installed}`);
  }

  const types = commitTypes(worktree, installed, log);

  enter("agent");
  rmSync(state.body, { force: true });

  const prompt = promptFor(readFileSync(PROMPT, "utf8"), {
    from: devHeader,
    to: installed,
    worktree,
    modules: (await hooksModulePlugins(worktree)).join(", "),
    body: state.body,
    types,
    dropped: droppedNote(dropped),
    previous: previousNote(open),
  });

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

function notify(outcome: Outcome, log: number): void {
  const result = command(
    [
      "notify-send",
      "-a",
      "Claude Code types",
      "-u",
      outcome.kind === "failed" ? "critical" : "normal",
      "Claude Code types",
      outcomeLine(outcome),
    ],
    process.cwd(),
  );

  if (result.code !== 0) writeSync(log, `notify-send exited ${result.code}: ${result.err}\n`);
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

const STOP_SIGNALS: readonly NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];

async function runPipeline(start: string): Promise<void> {
  // Every step runs from the main checkout: a run started inside a worktree it
  // recreates would lose its own working directory.
  const cwd = (await worktreesOf(start)).main;
  process.chdir(cwd);
  const state = statePaths(commonDirOf(cwd));
  const installed = installedVersion(command(["claude", "--version"], cwd).out);
  mkdirSync(state.dir, { recursive: true });
  const lock = takeRunLock(state, installed);

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
    notify(outcome, log);
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
      else await regenerate(git(process.cwd(), "rev-parse", "--show-toplevel"));
    } catch (error) {
      console.error(`claude-code-types: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
}
