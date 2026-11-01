// oxlint-disable max-classes-per-file -- the errors the git helpers throw, GitMissingError and GitError, live beside them: a caller tells them apart by instanceof
import type { Argv, BufferOutput, Env, RunOptions, RunResult, TextOutput } from "./process.ts";
import { OUTPUT_GRACE_MS, overlaid, sameName, spawnAsyncAs, spawnSyncAs } from "./process.ts";

export type GitOptions = RunOptions & {
  /** `LC_ALL=C`, so git's messages read the same in any locale. */
  readonly cLocale?: boolean;
  /** Leaves out every `GIT_*` variable of this process's environment, before `env` is laid over it. */
  readonly scrubGitEnv?: boolean;
  /** `-c <key>=<value>` before the arguments, one per entry. */
  readonly config?: readonly string[];
};

export type GitResult<Out = string> = Exclude<RunResult<Out>, { readonly kind: "missing" }>;

function gitEnvOf(options: GitOptions): Env {
  const base = options.scrubGitEnv === true ? withoutGitVariables(process.env) : process.env;

  return overlaid(base, options.cLocale === true ? { ...options.env, LC_ALL: "C" } : options.env);
}

function withoutGitVariables(env: Env): Env {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !sameName(name.slice(0, 4), "GIT_")),
  );
}

function gitArgv(args: readonly string[], options: GitOptions): Argv {
  return ["git", ...(options.config ?? []).flatMap((entry) => ["-c", entry]), ...args];
}

/** git is not on the PATH: `git`, `gitSync`, `gitRead` and `gitReadSync` throw it. */
export class GitMissingError extends Error {
  override readonly name = "GitMissingError";

  constructor() {
    super("git is not on the PATH");
  }
}

function found<Out>(result: RunResult<Out>): GitResult<Out> {
  if (result.kind === "missing") throw new GitMissingError();

  return result;
}

/**
 * Runs git through `run`, its output raw, untrimmed, `outputLost` kept as `run` sets it. A git
 * missing from the PATH throws a `GitMissingError`. `cwd` is an option; a call that names its
 * repository with `-C` keeps it in `args`.
 */
export function git(
  args: readonly string[],
  options: GitOptions & BufferOutput,
): Promise<GitResult<Buffer>>;
export function git(args: readonly string[], options?: GitOptions & TextOutput): Promise<GitResult>;
export async function git(
  args: readonly string[],
  options: GitOptions = {},
): Promise<GitResult<string | Buffer>> {
  return found(await spawnAsyncAs(gitArgv(args, options), options, gitEnvOf(options)));
}

export function gitSync(
  args: readonly string[],
  options: GitOptions & BufferOutput,
): GitResult<Buffer>;
export function gitSync(args: readonly string[], options?: GitOptions & TextOutput): GitResult;
export function gitSync(
  args: readonly string[],
  options: GitOptions = {},
): GitResult<string | Buffer> {
  return found(spawnSyncAs(gitArgv(args, options), options, gitEnvOf(options)));
}

/** How a git command ended, as `GitError` words it: its code or its timeout, then its stderr or its loss. */
function endingOf(result: GitResult): string {
  const ended =
    result.kind === "exited" ? `exited ${result.code}` : `timed out after ${result.timeoutMs} ms`;

  if (result.outputLost === true)
    return `${ended}, its output let go of after ${OUTPUT_GRACE_MS} ms`;

  return result.kind === "exited"
    ? `failed (exit ${result.code}): ${result.stderr.trim()}`
    : `${ended}: ${result.stderr.trim()}`;
}

/**
 * A git command that did not exit 0: `git <args> failed (exit <code>): <stderr>`, or timed out;
 * or whose output `run` let go of: `git <args> exited <code>, its output let go of after 1000 ms`.
 */
export class GitError extends Error {
  override readonly name = "GitError";

  readonly args: readonly string[];

  readonly result: GitResult;

  constructor(args: readonly string[], result: GitResult) {
    super(`git ${args.join(" ")} ${endingOf(result)}`);
    this.args = args;
    this.result = result;
  }
}

export type GitReadOptions = Omit<GitOptions, "stdout"> & {
  /** `true` answers stdout as git wrote it, for an output whose columns matter (`status --porcelain`). */
  readonly raw?: boolean;
};

function readOf(args: readonly string[], result: GitResult, options: GitReadOptions): string {
  if (result.kind !== "exited" || result.code !== 0 || result.outputLost === true)
    throw new GitError(args, result);

  return options.raw === true ? result.stdout : result.stdout.trim();
}

/**
 * A git command that must succeed: its stdout trimmed at both ends, or as git wrote it with
 * `raw`. Any other end throws a `GitError`, an exit 0 whose output `run` let go of included.
 */
export async function gitRead(
  args: readonly string[],
  options: GitReadOptions = {},
): Promise<string> {
  return readOf(args, await git(args, options), options);
}

/** `gitRead`, waiting in this thread: `gitSync` has no grace period, so no output is let go of. */
export function gitReadSync(args: readonly string[], options: GitReadOptions = {}): string {
  return readOf(args, gitSync(args, options), options);
}
