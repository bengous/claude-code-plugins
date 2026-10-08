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
 * version it last attempted live in `<git common dir>/claude-code-types/`,
 * where the hook reads them at session start.
 *
 * Claude Code writes a mod's types into its `.claude-plugin/types/` as it
 * loads it with `--plugin-dir`. `regenerate` loads an empty mod from a temp
 * directory and copies back the core and the tools; the MCP file describes a
 * session's own servers.
 */

import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { $ } from "bun";

import { isE2ePath } from "./check-e2e-green.ts";
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

const BOOT_ID = "/proc/sys/kernel/random/boot_id";

const REPORT_LINES = 60;

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
      to: string | null;
      step: Step;
      reason: string;
      log: string;
      worktree: string | null;
    };

/** `boot` tells a lock left by a run before a reboot from one whose pid came back; null off Linux. */
export interface Lock {
  pid: number;
  startedAt: string;
  boot: string | null;
}

export interface StatePaths {
  dir: string;
  lock: string;
  outcome: string;
  attempted: string;
  log: string;
  body: string;
}

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
    outcome: join(dir, "outcome.json"),
    attempted: join(dir, "attempted"),
    log: join(dir, "run.log"),
    body: join(dir, "pr-body.md"),
  };
}

export function outcomeLine(outcome: Outcome): string {
  switch (outcome.kind) {
    case "pr":
      return `Claude Code types ${outcome.from} → ${outcome.to}: pull request ${outcome.created ? "opened" : "updated"}, ${outcome.url}`;
    case "skipped":
      return `Claude Code types ${outcome.installed}: ${BASE} carries ${outcome.devHeader}, ${ROLLING_BRANCH} ${outcome.rollingHeader ?? "has no open pull request"}; nothing to do.`;
    case "failed":
      return `Claude Code types${outcome.to === null ? "" : ` ${outcome.to}`}: the run failed at ${outcome.step}: ${outcome.reason} (log: ${outcome.log}${outcome.worktree === null ? "" : `, worktree: ${outcome.worktree}`}). No session retries it; rerun by hand: bun ./scripts/claude-code-types.ts run`;
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

function isErrnoException(cause: unknown): cause is NodeJS.ErrnoException {
  return cause instanceof Error && "code" in cause;
}

function errnoOf(cause: unknown): string | undefined {
  return isErrnoException(cause) ? cause.code : undefined;
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

  return headerVersion(git(cwd, "show", object).split(/\r?\n/u, 1)[0] ?? "");
}

function fileHeader(root: string): string {
  return headerVersion(readFileSync(join(root, TYPES_PATH), "utf8").split(/\r?\n/u, 1)[0] ?? "");
}

/** The version the last run reached an end for, which no session start retries. */
export function attemptedVersion(file: string): string | null {
  return existsSync(file) ? readFileSync(file, "utf8").trim() : null;
}

function bootId(): string | null {
  try {
    return readFileSync(BOOT_ID, "utf8").trim();
  } catch (error) {
    if (errnoOf(error) === "ENOENT") return null;
    throw error;
  }
}

/** The lock's holder while its process lives; null when there is none, it died, or the machine rebooted since. */
export function liveLock(file: string): Lock | null {
  let lock: Lock;

  try {
    // SAFETY: only takeLock writes this file, whole, through a hard link.
    lock = JSON.parse(readFileSync(file, "utf8")) as Lock;
  } catch (error) {
    if (errnoOf(error) === "ENOENT") return null;
    throw error;
  }

  if (lock.boot !== null && lock.boot !== bootId()) return null;

  try {
    process.kill(lock.pid, 0);

    return lock;
  } catch (error) {
    const code = errnoOf(error);

    if (code === "ESRCH") return null;

    if (code === "EPERM") return lock;
    throw error;
  }
}

/** Takes the lock, or answers false while a live run holds it. */
function takeLock(file: string): boolean {
  const left = existsSync(file);

  if (liveLock(file) !== null) return false;

  // Only a dead run's lock is removed: removing an absent one could take the
  // lock a run started at the same moment just linked.
  if (left) rmSync(file, { force: true });

  // A hard link appears whole or not at all, so a reader never parses a half-written lock.
  const draft = `${file}.${process.pid}`;
  const lock: Lock = { pid: process.pid, startedAt: new Date().toISOString(), boot: bootId() };
  writeFileSync(draft, JSON.stringify(lock));

  try {
    linkSync(draft, file);

    return true;
  } catch (error) {
    if (errnoOf(error) === "EEXIST") return false;
    throw error;
  } finally {
    rmSync(draft, { force: true });
  }
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

  if (checkouts.some((tree) => tree.dir === path)) git(cwd, "worktree", "remove", "--force", path);
  git(cwd, "worktree", "prune");

  if (existsSync(path)) throw new Error(`${path} exists and is no worktree of this repository`);
  git(cwd, "worktree", "add", "--quiet", "-B", ROLLING_BRANCH, path, live ? ROLLING_REMOTE : BASE);

  if (!live || command(["git", "rebase", "--quiet", BASE], path).code === 0) return "";

  const dropped = git(path, "log", "--format=%h %s", `${BASE}..${ROLLING_REMOTE}`);
  git(path, "rebase", "--abort");
  git(path, "reset", "--quiet", "--hard", BASE);

  return dropped;
}

async function install(worktree: string, log: number): Promise<void> {
  for (const args of INSTALLS) {
    const code = await logged(args, worktree, log);

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

/** Runs a command with its output appended to the log; answers its exit code. */
async function logged(
  args: readonly string[],
  cwd: string,
  log: number,
  env: Record<string, string> = {},
): Promise<number> {
  return await Bun.spawn([...args], {
    cwd,
    env: { ...process.env, ...env },
    stdin: "ignore",
    stdout: log,
    stderr: log,
  }).exited;
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
  worktree: string;
  state: StatePaths;
  log: number;
  enter: (step: Step) => void;
  reach: (version: string) => void;
}

async function pipeline({ cwd, worktree, state, log, enter, reach }: Run): Promise<Outcome> {
  enter("fetch");
  const installed = installedVersion(command(["claude", "--version"], cwd).out);
  reach(installed);
  git(cwd, "fetch", "--quiet", "--prune", "origin");
  const devHeader = refHeader(cwd, BASE);

  if (devHeader === null) throw new Error(`${BASE} carries no ${TYPES_PATH}`);
  const open = openPullRequest(cwd);
  const rollingHeader = open === null ? null : refHeader(cwd, ROLLING_REMOTE);
  const versions = { installed, devHeader, rollingHeader };

  if (!needsRun(versions)) return { kind: "skipped", ...versions };

  enter("worktree");
  const dropped = await prepareWorktree(cwd, worktree, rollingHeader !== null);

  enter("install");
  await install(worktree, log);

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
    log,
    { [RUN_GUARD]: "1" },
  );

  if (agent !== 0) throw new Error(`claude -p exited ${agent}`);

  enter("verify");
  verify(worktree, installed, state.body);

  enter("push");

  const pushed = await logged(
    ["git", "push", "--force-with-lease", "origin", ROLLING_BRANCH],
    worktree,
    log,
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

async function runPipeline(cwd: string): Promise<void> {
  const state = statePaths(commonDirOf(cwd));
  mkdirSync(state.dir, { recursive: true });

  if (!takeLock(state.lock)) {
    console.error(`claude-code-types: a live run holds ${state.lock}`);

    return;
  }

  writeFileSync(state.log, "");
  // Append mode, so the lines of the children that share this descriptor follow each other.
  const log = openSync(state.log, "a");
  const worktree = await worktreePath(cwd);
  let step: Step = "fetch";
  let target: string | null = null;
  let outcome: Outcome;

  const enter = (next: Step) => {
    step = next;
    writeSync(log, `== ${next}\n`);
  };

  const reach = (version: string) => {
    target = version;
  };

  try {
    outcome = await pipeline({ cwd, worktree, state, log, enter, reach });
  } catch (error) {
    outcome = {
      kind: "failed",
      to: target,
      step,
      reason: error instanceof Error ? error.message : String(error),
      log: state.log,
      worktree: existsSync(worktree) ? worktree : null,
    };
  }

  writeSync(log, `${outcomeLine(outcome)}\n`);
  writeFileSync(state.outcome, JSON.stringify(outcome));

  if (target !== null) writeFileSync(state.attempted, target);

  if (outcome.kind !== "skipped") notify(outcome, log);
  closeSync(log);
  rmSync(state.lock, { force: true });
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
