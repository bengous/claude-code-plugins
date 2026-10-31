#!/usr/bin/env bun

/**
 * SessionStart hook — mounts the private repository that `.private.env`, in
 * the main checkout, names: clones it once into the main checkout's
 * `.private/`, adds each link it makes to `<git common dir>/info/exclude`,
 * then links `plans`, `.scratch` and each private skill into the
 * checkout the session starts in. Without `.private.env` it does nothing.
 * It never touches a path that exists already, whatever stands there.
 */

import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";

import { $ } from "bun";

import { NO_PROMPT } from "./auto-sweep.ts";
import { checkoutRoot, gitDiscoveryEnv } from "./checkout.ts";
import { HOOK_EXIT } from "./hook-io.ts";
import { isErrnoException } from "./once-a-day.ts";

const CONFIG = ".private.env";

const REPO_KEY = "PRIVATE_REPO=";

const CLONE_ENV = {
  ...NO_PROMPT,
  GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=10",
};

type Repository = { main: string; commonDir: string };

type SessionStartOutput = {
  systemMessage?: string;
  hookSpecificOutput?: { hookEventName: "SessionStart"; reloadSkills: true };
};

async function repositoryOf(root: string): Promise<Repository> {
  const run = await $`git -C ${root} rev-parse --path-format=absolute --git-common-dir`
    .env(await gitDiscoveryEnv())
    .nothrow()
    .quiet();

  if (run.exitCode !== 0) {
    throw new Error(
      `git rev-parse in ${root} exited ${run.exitCode}: ${run.stderr.toString().trim()}`,
    );
  }

  const commonDir = realpathSync(run.text().trim());

  return { main: dirname(commonDir), commonDir };
}

function privateRepo(main: string): string | null {
  const file = join(main, CONFIG);

  if (!existsSync(file)) return null;

  const line = readFileSync(file, "utf8")
    .split("\n")
    .find((entry) => entry.startsWith(REPO_KEY));

  const url = line?.slice(REPO_KEY.length).trim() ?? "";

  if (url === "") throw new Error(`${file} names no repository: write a ${REPO_KEY}<url> line`);

  return url;
}

/**
 * Clones into a staging copy renamed into place, so an interrupted clone never
 * leaves a partial `into`. False when a concurrent session renamed its own first.
 */
async function clone(url: string, into: string): Promise<boolean> {
  const staging = `${into}.tmp-${process.pid}`;

  const proc = Bun.spawn(["git", "clone", "--quiet", url, staging], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
    env: { ...(await gitDiscoveryEnv()), ...CLONE_ENV },
  });

  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

  if (exitCode !== 0) {
    rmSync(staging, { recursive: true, force: true });
    const [first = `exit ${exitCode}`] = stderr.trim().split("\n");

    throw new Error(`cloning ${CONFIG}'s repository into ${into} failed: ${first}`);
  }

  try {
    renameSync(staging, into);

    return true;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });

    if (isErrnoException(error) && (error.code === "ENOTEMPTY" || error.code === "EEXIST")) {
      return false;
    }

    throw error;
  }
}

function skillNames(privateDir: string): string[] {
  const dir = join(privateDir, "skills");

  if (!existsSync(dir)) return [];

  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/** Appends each missing line; the lines already there stay as they are. */
function exclude(commonDir: string, lines: string[]): void {
  const file = join(commonDir, "info", "exclude");
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const present = new Set(text.split("\n"));
  const missing = lines.filter((line) => !present.has(line));

  if (missing.length === 0) return;
  mkdirSync(dirname(file), { recursive: true });
  const separator = text === "" || text.endsWith("\n") ? "" : "\n";

  appendFileSync(file, `${separator}${missing.join("\n")}\n`);
}

/** A relative link at `path`, unless something stands there; true when it made one. */
function link(path: string, target: string): boolean {
  try {
    symlinkSync(relative(dirname(path), target), path);

    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === "EEXIST") return false;
    throw error;
  }
}

const isDirectory = (path: string): boolean =>
  lstatSync(path, { throwIfNoEntry: false })?.isDirectory() === true;

export async function sync(
  cwd: string | undefined,
  projectDir: string,
): Promise<SessionStartOutput | null> {
  const root = await checkoutRoot(cwd, projectDir);
  const { main, commonDir } = await repositoryOf(root);
  const url = privateRepo(main);

  if (url === null) return null;
  const privateDir = join(main, ".private");
  const cloned = !existsSync(privateDir) && (await clone(url, privateDir));
  const skills = skillNames(privateDir);

  // A branch older than the .gitignore lines for these links would show them untracked.
  exclude(commonDir, ["/plans", "/.scratch", ...skills.map((name) => `/.claude/skills/${name}`)]);
  link(join(root, "plans"), join(privateDir, "plans"));
  link(join(root, ".scratch"), join(privateDir, "scratch"));
  const skillsDir = join(root, ".claude", "skills");

  // A worktree with no .claude/skills/ of its own loads the main checkout's:
  // creating the directory would cut them off.
  const linkedSkill =
    isDirectory(skillsDir) &&
    skills
      .map((name) => link(join(skillsDir, name), join(privateDir, "skills", name)))
      .includes(true);

  if (!cloned && !linkedSkill) return null;

  return {
    ...(cloned && {
      systemMessage: `private-sync: cloned the private repository into ${privateDir}`,
    }),
    ...(linkedSkill && {
      hookSpecificOutput: { hookEventName: "SessionStart", reloadSkills: true },
    }),
  };
}

if (import.meta.main) {
  try {
    // SAFETY: `cwd` is the one field read, and an absent one falls back to the project.
    const { cwd } = JSON.parse(await Bun.stdin.text()) as { cwd?: string };
    const output = await sync(cwd, process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd());

    if (output !== null) console.log(JSON.stringify(output));
  } catch (error) {
    // Claude Code shows the first stderr line of a failed hook, and an
    // uncaught throw makes that line a Bun source frame.
    console.error(`private-sync: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(HOOK_EXIT.ERROR);
  }
}
