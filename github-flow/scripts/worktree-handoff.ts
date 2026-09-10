#!/usr/bin/env bun

// worktree-handoff — Backend for the /github-flow:stacked-prs worktree step.
//
// Creates a branch and a worktree from the top of a stack, links the gitignored
// orchestration folder into it, installs the dependencies, and prints one JSON
// object. The orchestration folder holds the handoffs a session reads and the
// checklists it writes; a fresh worktree contains none of it, so every file is
// symlinked back to the main checkout instead of copied.

import { $, Glob } from "bun";
import { existsSync, lstatSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, symlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs as parseArgv } from "node:util";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Install = { kind: "detect" } | { kind: "skip" } | { kind: "command"; command: string };

export type Options = {
  branch: string;
  base: string;
  dir: string;
  handoff: string | null;
  path: string | null;
  links: readonly string[];
  install: Install;
};

export type ErrorCode =
  | "usage"
  | "invalid-arguments"
  | "not-a-git-repo"
  | "inside-a-worktree"
  | "orchestration-dir-missing"
  | "handoff-missing"
  | "fetch-failed"
  | "base-not-found"
  | "branch-exists"
  | "worktree-path-exists"
  | "worktree-add-failed"
  | "install-failed"
  | "handoff-not-visible"
  | "unexpected-failure";

export type Success = {
  ok: true;
  worktree: string;
  branch: string;
  base: string;
  handoff: string;
  linked: number;
  links_missing: string[];
  install: string | null;
  launch: string;
  cleanup: string;
};

export type Failure = { ok: false; error: ErrorCode; detail: string };

export type Result = Success | Failure;

const USAGE = `Usage: worktree-handoff.ts <branch> --base <ref> [options]

  <branch>            Branch to create. Also names the handoff
                      (<dir>/handoffs/<branch>.md) and the worktree path.
  --base <ref>        Required. The TOP of the stack (the last pushed layer),
                      e.g. --base origin/layer-2. No default: a layer cut from
                      the trunk or from the stack base misses its neighbours
                      and conflicts on shared additive files.
  --dir <folder>      Gitignored orchestration folder (default: .gh).
  --handoff <file>    Explicit handoff when the name does not follow the convention.
  --path <folder>     Worktree location (default: ../<repo>-<branch, slashes to dashes>).
  --link <file>       Extra gitignored file to symlink from the main checkout
                      (local secrets: .dev.vars, .env.local). Repeatable.
  --install <cmd>     Dependency install command, run through the shell. Default:
                      detected from the lockfile. --install '' skips it.`;

const LOCKFILES: ReadonlyArray<readonly [lockfile: string, command: string]> = [
  ["bun.lock", "bun install"],
  ["bun.lockb", "bun install"],
  ["pnpm-lock.yaml", "pnpm install"],
  ["yarn.lock", "yarn install"],
  ["package-lock.json", "npm install"],
  ["uv.lock", "uv sync"],
  ["poetry.lock", "poetry install"],
  ["Cargo.lock", "cargo fetch"],
  ["go.sum", "go mod download"],
];

// ---------------------------------------------------------------------------
// Pure parts
// ---------------------------------------------------------------------------

export type ParsedArgs = { ok: true; options: Options } | { ok: false; error: string };

const ARG_OPTIONS = {
  base: { type: "string" },
  dir: { type: "string" },
  handoff: { type: "string" },
  path: { type: "string" },
  link: { type: "string", multiple: true },
  install: { type: "string" },
} as const;

type RawArgs = ReturnType<typeof parseRaw>;

function parseRaw(argv: readonly string[]) {
  return parseArgv({ args: [...argv], options: ARG_OPTIONS, strict: true, allowPositionals: true });
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let raw: RawArgs;
  try {
    raw = parseRaw(argv);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const { values, positionals } = raw;
  const [branch, ...extra] = positionals;
  if (branch === undefined) return { ok: false, error: "missing branch" };
  if (extra.length > 0) {
    return { ok: false, error: `branch given twice: ${branch}, ${extra.join(", ")}` };
  }
  if (values.base === undefined) {
    return { ok: false, error: "--base is required: pass the top of the stack" };
  }
  return {
    ok: true,
    options: {
      branch,
      base: values.base,
      dir: values.dir ?? ".gh",
      handoff: values.handoff ?? null,
      path: values.path ?? null,
      links: values.link ?? [],
      install: parseInstall(values.install),
    },
  };
}

function parseInstall(value: string | undefined): Install {
  if (value === undefined) return { kind: "detect" };
  if (value === "") return { kind: "skip" };
  return { kind: "command", command: value };
}

export function detectInstall(present: ReadonlySet<string>): string | null {
  for (const [lockfile, command] of LOCKFILES) {
    if (present.has(lockfile)) return command;
  }
  return null;
}

function resolveInstall(install: Install, present: ReadonlySet<string>): string | null {
  switch (install.kind) {
    case "detect":
      return detectInstall(present);
    case "skip":
      return null;
    case "command":
      return install.command;
    default: {
      const unreachable: never = install;
      throw new Error(`unhandled install kind: ${JSON.stringify(unreachable)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Git and filesystem helpers
// ---------------------------------------------------------------------------

type GitResult = { stdout: string; stderr: string; exitCode: number };

async function git(...args: string[]): Promise<GitResult> {
  const { stdout, stderr, exitCode } = await $`git ${args}`.quiet().nothrow();
  return { stdout: stdout.toString().trim(), stderr: stderr.toString().trim(), exitCode };
}

async function gitOk(...args: string[]): Promise<string> {
  const result = await git(...args);
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

async function refExists(ref: string): Promise<boolean> {
  return (await git("show-ref", "--verify", "--quiet", ref)).exitCode === 0;
}

function fail(error: ErrorCode, detail: string): Failure {
  return { ok: false, error, detail };
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Links `source` at `target` unless something is already there; returns whether it linked. */
async function linkInto(source: string, target: string): Promise<boolean> {
  if (existsSync(target) || isSymlink(target)) return false;
  await mkdir(dirname(target), { recursive: true });
  await symlink(source, target);
  return true;
}

async function excludeLocally(dir: string): Promise<void> {
  const exclude = await gitOk("rev-parse", "--git-path", "info/exclude");
  const lines = existsSync(exclude) ? (await readFile(exclude, "utf8")).split("\n") : [];
  if (lines.includes(`${dir}/`)) return;
  await mkdir(dirname(exclude), { recursive: true });
  await appendFile(
    exclude,
    `# orchestration folder outside the repo (worktree-handoff.ts)\n${dir}/\n`,
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run(options: Options): Promise<Result> {
  const gitDir = await git("rev-parse", "--git-dir");
  if (gitDir.exitCode !== 0) return fail("not-a-git-repo", gitDir.stderr);
  if (gitDir.stdout.includes("/worktrees/")) {
    return fail("inside-a-worktree", "run this script from the main checkout");
  }
  const root = await gitOk("rev-parse", "--show-toplevel");
  process.chdir(root);

  const { branch, base, dir } = options;
  const handoff = options.handoff ?? join(dir, "handoffs", `${branch}.md`);
  const worktree = resolve(
    options.path ?? join("..", `${basename(root)}-${branch.replaceAll("/", "-")}`),
  );

  if (!existsSync(dir)) return fail("orchestration-dir-missing", `${dir} (option --dir)`);
  if (!existsSync(handoff)) {
    const handoffs = join(dir, "handoffs");
    const available = existsSync(handoffs)
      ? (await readdir(handoffs)).filter((name) => name.endsWith(".md"))
      : [];
    return fail(
      "handoff-missing",
      `${handoff}\n\nAvailable: ${available.length === 0 ? "(none)" : available.join(", ")}`,
    );
  }

  const fetch = await git("fetch", "origin", "--quiet");
  if (fetch.exitCode !== 0) return fail("fetch-failed", fetch.stderr);

  const baseRef = await git("rev-parse", "--verify", "--quiet", `${base}^{commit}`);
  if (baseRef.exitCode !== 0) {
    const recent = await gitOk(
      "for-each-ref",
      "--sort=-committerdate",
      "--count=10",
      "--format=%(refname:short)",
      "refs/remotes/origin",
    );
    return fail("base-not-found", `${base}\n\nRecent remote branches:\n${recent}`);
  }

  if (
    (await refExists(`refs/heads/${branch}`)) ||
    (await refExists(`refs/remotes/origin/${branch}`))
  ) {
    return fail("branch-exists", `${branch}: reuse its worktree or pick another name`);
  }
  if (existsSync(worktree)) return fail("worktree-path-exists", worktree);

  const install = resolveInstall(options.install, new Set(await readdir(root)));

  const added = await git("worktree", "add", "-b", branch, worktree, base);
  if (added.exitCode !== 0) return fail("worktree-add-failed", added.stderr);

  // Files already present came from git and are never overwritten.
  let linked = 0;
  for await (const file of new Glob("**/*").scan({ cwd: join(root, dir), dot: true })) {
    if (await linkInto(join(root, dir, file), join(worktree, dir, file))) linked += 1;
  }

  // A branch created before the orchestration folder entered .gitignore would
  // show the links above as untracked files. info/exclude is shared by every
  // worktree and never versioned, so it covers every branch.
  await excludeLocally(dir);

  const linksMissing: string[] = [];
  for (const link of options.links) {
    const source = join(root, link);
    if (existsSync(source)) await linkInto(source, join(worktree, link));
    else linksMissing.push(link);
  }

  if (install !== null) {
    const { exitCode } = await $`${{ raw: install }}`.cwd(worktree).nothrow();
    if (exitCode !== 0) return fail("install-failed", `${install} exited with ${exitCode}`);
  }

  if (!existsSync(join(worktree, handoff))) {
    return fail("handoff-not-visible", join(worktree, handoff));
  }

  return {
    ok: true,
    worktree,
    branch,
    base,
    handoff,
    linked,
    links_missing: linksMissing,
    install,
    launch: `cd ${worktree} && claude "Execute the handoff ${handoff}"`,
    cleanup: `git worktree remove --force ${worktree}`,
  };
}

function main(argv: readonly string[]): Promise<Result> | Result {
  if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
    return fail("usage", USAGE);
  }
  const parsed = parseArgs(argv);
  if (parsed.ok) return run(parsed.options);
  return fail("invalid-arguments", `${parsed.error}\n\n${USAGE}`);
}

if (import.meta.main) {
  let result: Result;
  try {
    result = await main(Bun.argv.slice(2));
  } catch (error) {
    result = fail("unexpected-failure", error instanceof Error ? error.message : String(error));
  }
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}
