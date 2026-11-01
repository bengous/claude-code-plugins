// oxlint-disable max-classes-per-file -- the errors the helpers throw (GitError, GitMissingError, LaunchError) live beside them: a caller tells them apart by instanceof, and a plugin's copy is this one file
import { linkSync, mkdirSync, renameSync as fsRenameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, open, readFile, rename as fsRename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:os";
import { basename, dirname, join } from "node:path";

import { errnoOf, isErrno, messageOf } from "./pure.ts";

const HELD_CODES: ReadonlySet<unknown> = new Set(["EBUSY", "EPERM", "EACCES"]);

const HELD_RETRY_STEP_MS = 100;

/**
 * Whether Windows refused a rename because a program holds the file or folder (`EBUSY`, `EPERM`,
 * `EACCES`). POSIX renames a held folder, and an `EPERM` there is a real refusal: always false.
 */
export function isHeld(cause: unknown): boolean {
  return (
    process.platform === "win32" &&
    cause instanceof Error &&
    "code" in cause &&
    HELD_CODES.has(cause.code)
  );
}

export type RenameOptions = {
  /** How long a rename Windows refuses as held is tried again, every 100 ms; `0` by default. */
  readonly heldRetryMs?: number;
};

export async function rename(from: string, to: string, options: RenameOptions = {}): Promise<void> {
  const until = Date.now() + (options.heldRetryMs ?? 0);

  for (;;) {
    try {
      await fsRename(from, to);

      return;
    } catch (cause) {
      if (!isHeld(cause) || Date.now() >= until) throw cause;
      await Bun.sleep(HELD_RETRY_STEP_MS);
    }
  }
}

export function renameSync(from: string, to: string, options: RenameOptions = {}): void {
  const until = Date.now() + (options.heldRetryMs ?? 0);

  for (;;) {
    try {
      fsRenameSync(from, to);

      return;
    } catch (cause) {
      if (!isHeld(cause) || Date.now() >= until) throw cause;
      Bun.sleepSync(HELD_RETRY_STEP_MS);
    }
  }
}

/** A scratch name beside `file`, unique to this write: `.<base>.<pid>.<uuid>.tmp`. */
function scratchBeside(file: string): string {
  return join(dirname(file), `.${basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
}

export type WriteAtomicOptions = RenameOptions & {
  /** Creates the file's directory, and its parents, first. */
  readonly mkdir?: boolean;
};

/**
 * Writes `data` to a scratch file beside `file`, then renames it over `file`: a reader meets the
 * old content or the new, whole, and two writers never rename each other's scratch file. The
 * scratch file is removed when the write or the rename fails. No fsync: a process crash or a
 * concurrent writer is what this guards against, not a power loss. The rename replaces what `file`
 * was: a symbolic link becomes a file, and the mode is the new file's default.
 */
export async function writeAtomic(
  file: string,
  data: string | Uint8Array,
  options: WriteAtomicOptions = {},
): Promise<void> {
  if (options.mkdir === true) await mkdir(dirname(file), { recursive: true });
  const scratch = scratchBeside(file);

  try {
    await writeFile(scratch, data);
    await rename(scratch, file, options);
  } catch (cause) {
    await rm(scratch, { force: true });
    throw cause;
  }
}

export function writeAtomicSync(
  file: string,
  data: string | Uint8Array,
  options: WriteAtomicOptions = {},
): void {
  if (options.mkdir === true) mkdirSync(dirname(file), { recursive: true });
  const scratch = scratchBeside(file);

  try {
    writeFileSync(scratch, data);
    renameSync(scratch, file, options);
  } catch (cause) {
    rmSync(scratch, { force: true });
    throw cause;
  }
}

/**
 * Creates `file` holding `data`, unless it exists: `false` then, and `file` untouched. The data is
 * written to a scratch file first and linked into place, so a reader never meets it half-written.
 */
export function createExclusiveSync(file: string, data: string | Uint8Array): boolean {
  const scratch = scratchBeside(file);

  try {
    writeFileSync(scratch, data);
    linkSync(scratch, file);

    return true;
  } catch (cause) {
    if (isErrno(cause, "EEXIST")) return false;
    throw cause;
  } finally {
    rmSync(scratch, { force: true });
  }
}

const LOCK_POLL_MS = 50;

export type LockOptions = {
  /** How long to wait for another holder to let go before throwing. */
  readonly timeoutMs: number;
};

const LOCK_HOLDER = /^(\d+) (\S+)$/u;

/**
 * What the lock file holds; `null` when there is none to read: its holder let go, or, on Windows,
 * the file it removed is pending deletion (`isHeld`).
 */
function lockText(lockFile: string): Promise<string | null> {
  return readFile(lockFile, "utf8").catch((cause: unknown) => {
    if (isErrno(cause, "ENOENT") || isHeld(cause)) return null;
    throw cause;
  });
}

function heldLockError(lockFile: string, timeoutMs: number, text: string): Error {
  const [, pid, since] = LOCK_HOLDER.exec(text.trim()) ?? [];
  const age = since === undefined ? Number.NaN : Date.now() - Date.parse(since);
  const holder = pid === undefined ? "an unknown holder" : `pid ${pid}`;
  const held = Number.isNaN(age) ? "" : ` for ${age} ms`;

  return new Error(
    `${lockFile} is still locked after ${timeoutMs} ms, by ${holder}${held}; if no such process runs, remove the lock file`,
  );
}

/**
 * An attempt at the lock: `taken`, `held` by another, or `refused` as Windows refuses a file a
 * holder removes while it is pending deletion (`isHeld`), which a real refusal reads as too.
 */
type LockAttempt =
  | { readonly kind: "taken" }
  | { readonly kind: "held" }
  | { readonly kind: "refused"; readonly cause: unknown };

/** Tries to create the lock file with this process's pid and the date. */
async function tryLock(lockFile: string): Promise<LockAttempt> {
  let attempt: LockAttempt = { kind: "held" };

  const handle = await open(lockFile, "wx").catch((cause: unknown) => {
    if (isHeld(cause)) attempt = { kind: "refused", cause };
    else if (!isErrno(cause, "EEXIST")) throw cause;

    return null;
  });

  if (handle === null) return attempt;

  try {
    await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`);
  } catch (cause) {
    await handle.close();
    await rm(lockFile, { force: true });
    throw cause;
  }

  await handle.close();

  return { kind: "taken" };
}

/**
 * Runs `fn` while holding `lockFile`, created exclusively with this process's pid and the date;
 * waits for another holder up to `timeoutMs`, then throws naming the file, the holder's pid and
 * the lock's age. The lock is removed once `fn` settles. A lock its holder left behind is never
 * taken over: it is reported, for a human to remove.
 */
export async function withLock<T>(
  lockFile: string,
  fn: () => Promise<T>,
  options: LockOptions,
): Promise<T> {
  const until = performance.now() + options.timeoutMs;
  let attempt = await tryLock(lockFile);

  while (attempt.kind !== "taken") {
    if (performance.now() >= until) {
      const text = await lockText(lockFile);

      if (text !== null) throw heldLockError(lockFile, options.timeoutMs, text);
      // No lock file to read: its holder let go since the last try, so one more; a refusal that
      // outlasts the wait with no file behind it is a real one, and its own error.
      attempt = await tryLock(lockFile);

      if (attempt.kind === "taken") break;

      if (attempt.kind === "refused") throw attempt.cause;
      throw heldLockError(lockFile, options.timeoutMs, "");
    }

    await Bun.sleep(LOCK_POLL_MS);
    attempt = await tryLock(lockFile);
  }

  try {
    return await fn();
  } finally {
    await rm(lockFile, { force: true });
  }
}

export type Argv = readonly [program: string, ...args: string[]];

/** Variables laid over this process's environment: a value sets one, `undefined` removes it. */
export type EnvOverlay = Readonly<Record<string, string | undefined>>;

export type RunOptions = {
  /** The process's directory; this process's own by default. */
  readonly cwd?: string;
  /** Laid over this process's environment, which the child gets in full otherwise. */
  readonly env?: EnvOverlay;
  /** No timeout by default; `<= 0` answers `timedOut` without starting the process. */
  readonly timeoutMs?: number;
  readonly stdin?: string | Uint8Array;
  /** `"buffer"` answers stdout as bytes; text by default. */
  readonly stdout?: "text" | "buffer";
};

export type BufferOutput = { readonly stdout: "buffer" };

export type TextOutput = { readonly stdout?: "text" };

export type RunResult<Out = string> =
  | {
      readonly kind: "exited";
      readonly code: number;
      readonly stdout: Out;
      readonly stderr: string;
      /** `run` let go of the pipes once `OUTPUT_GRACE_MS` passed: stdout and stderr are empty. */
      readonly outputLost?: true;
    }
  | {
      readonly kind: "timedOut";
      readonly timeoutMs: number;
      readonly stdout: Out;
      readonly stderr: string;
      /** `run` let go of the pipes once `OUTPUT_GRACE_MS` passed: stdout and stderr are empty. */
      readonly outputLost?: true;
    }
  | { readonly kind: "missing"; readonly program: string };

/** The output a killed shell's children may keep holding is waited for this long after the exit. */
export const OUTPUT_GRACE_MS = 1000;

/** Bun's words for a program it cannot find on the PATH; any other spawn failure is a `LaunchError`. */
const NOT_FOUND = /^Executable not found/u;

function isNotFound(cause: unknown): boolean {
  return cause instanceof Error && NOT_FOUND.test(cause.message);
}

/**
 * A program that could not start for another reason than a name the PATH does not hold: a missing
 * `cwd`, a path to no program, a program it may not run (`EACCES`). It keeps Bun's message, Bun's
 * error as `cause`, and its errno as `code`, so `errnoOf` reads what it read off Bun's error.
 */
export class LaunchError extends Error {
  override readonly name = "LaunchError";

  readonly code: string | undefined;

  constructor(cause: unknown) {
    super(messageOf(cause), { cause });
    this.code = errnoOf(cause) ?? undefined;
  }
}

type Env = Readonly<Record<string, string | undefined>>;

const SIGNALS: ReadonlyMap<string, number> = new Map(Object.entries(constants.signals));

/** The code a shell reports for a process a signal ended, as Bun's async `exited` answers it. */
function signalExitCode(signal: NodeJS.Signals | number): number {
  return 128 + (SIGNALS.get(String(signal)) ?? Number(signal));
}

/** The input as a `Response` body, which takes bytes over a plain `ArrayBuffer` only. */
function bodyOf(input: string | Uint8Array): string | Uint8Array<ArrayBuffer> {
  if (!(input instanceof Uint8Array)) return input;
  const bytes = new Uint8Array(input.byteLength);
  bytes.set(input);

  return bytes;
}

function bytesOf(input: string | Uint8Array): Uint8Array {
  return input instanceof Uint8Array ? input : new TextEncoder().encode(input);
}

/** A pipe read to its end, or let go of: a reader cancelled releases what a lingering child holds. */
type Reading = { readonly bytes: Promise<Buffer>; readonly cancel: () => Promise<void> };

function reading(stream: ReadableStream<Uint8Array>): Reading {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];

  const bytes = (async () => {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) return Buffer.concat(chunks);
      chunks.push(value);
    }
  })();

  // A read that fails while the child runs is read where the output is awaited; until then it must not end the process as unhandled.
  bytes.catch(() => null);

  return { bytes, cancel: () => reader.cancel() };
}

/**
 * Both pipes' bytes, or `null` once `OUTPUT_GRACE_MS` passed. Unless both were read whole, a read
 * that failed included, both pipes are let go of.
 */
async function graced(stdout: Reading, stderr: Reading): Promise<readonly [Buffer, Buffer] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let read = false;

  const grace = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), OUTPUT_GRACE_MS);
  });

  try {
    const output = await Promise.race([Promise.all([stdout.bytes, stderr.bytes]), grace]);
    read = output !== null;

    return output;
  } finally {
    clearTimeout(timer);

    if (!read) await Promise.allSettled([stdout.cancel(), stderr.cancel()]);
  }
}

/** Text output as `Response.text()` reads it: UTF-8, a leading BOM dropped. */
const UTF8 = new TextDecoder();

async function spawnAsync<Out>(
  argv: Argv,
  options: RunOptions,
  env: Env,
  read: (bytes: Buffer) => Out,
  empty: Out,
): Promise<RunResult<Out>> {
  if (options.timeoutMs !== undefined && options.timeoutMs <= 0) {
    return { kind: "timedOut", timeoutMs: options.timeoutMs, stdout: empty, stderr: "" };
  }

  let proc: Bun.Subprocess<"ignore" | Response, "pipe", "pipe">;
  const started = performance.now();

  try {
    proc = Bun.spawn([...argv], {
      cwd: options.cwd ?? process.cwd(),
      env,
      stdin: options.stdin === undefined ? "ignore" : new Response(bodyOf(options.stdin)),
      stdout: "pipe",
      stderr: "pipe",
      timeout: options.timeoutMs ?? 0,
      killSignal: "SIGKILL",
      windowsHide: true,
    });
  } catch (cause) {
    if (isNotFound(cause)) return { kind: "missing", program: argv[0] };
    throw new LaunchError(cause);
  }

  const pipes = [reading(proc.stdout), reading(proc.stderr)] as const;
  const code = await proc.exited;
  const lasted = performance.now() - started;
  // A killed shell leaves its children holding the pipes: wait for the output only as long as the grace period.
  const output = await graced(...pipes);
  const { timeoutMs } = options;
  // An async Subprocess carries no timeout flag: the kill signal we asked for, once the timeout passed, is the only evidence Bun cut it short.
  const timedOut = timeoutMs !== undefined && proc.signalCode === "SIGKILL" && lasted >= timeoutMs;

  if (output === null) {
    return timedOut
      ? { kind: "timedOut", timeoutMs, stdout: empty, stderr: "", outputLost: true }
      : { kind: "exited", code, stdout: empty, stderr: "", outputLost: true };
  }

  const stdout = read(output[0]);
  const stderr = UTF8.decode(output[1]);

  return timedOut
    ? { kind: "timedOut", timeoutMs, stdout, stderr }
    : { kind: "exited", code, stdout, stderr };
}

function spawnSync<Out>(
  argv: Argv,
  options: RunOptions,
  env: Env,
  read: (bytes: Buffer) => Out,
  empty: Out,
): RunResult<Out> {
  if (options.timeoutMs !== undefined && options.timeoutMs <= 0) {
    return { kind: "timedOut", timeoutMs: options.timeoutMs, stdout: empty, stderr: "" };
  }

  let result: Bun.SyncSubprocess<"pipe", "pipe">;

  try {
    result = Bun.spawnSync([...argv], {
      cwd: options.cwd ?? process.cwd(),
      env,
      stdin: options.stdin === undefined ? "ignore" : bytesOf(options.stdin),
      stdout: "pipe",
      stderr: "pipe",
      timeout: options.timeoutMs ?? 0,
      killSignal: "SIGKILL",
      windowsHide: true,
    });
  } catch (cause) {
    if (isNotFound(cause)) return { kind: "missing", program: argv[0] };
    throw new LaunchError(cause);
  }

  const stdout = read(result.stdout);
  const stderr = UTF8.decode(result.stderr);

  if (options.timeoutMs !== undefined && result.exitedDueToTimeout === true) {
    return { kind: "timedOut", timeoutMs: options.timeoutMs, stdout, stderr };
  }

  const code =
    result.signalCode === undefined ? result.exitCode : signalExitCode(result.signalCode);

  return { kind: "exited", code, stdout, stderr };
}

/** Windows reads a variable's name whatever its case: `Path` and `PATH` are one variable there. */
const sameName =
  process.platform === "win32"
    ? (a: string, b: string): boolean => a.toUpperCase() === b.toUpperCase()
    : (a: string, b: string): boolean => a === b;

/**
 * `base` with `overlay` laid over it, entry by entry: a value sets its variable, `undefined`
 * removes it, and each entry replaces every variable of the same name before it, the overlay's own.
 */
function overlaid(base: Env, overlay: EnvOverlay = {}): Env {
  const env = new Map<string, string>();

  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined) env.set(name, value);
  }

  for (const [name, value] of Object.entries(overlay)) {
    for (const laid of env.keys()) {
      if (sameName(laid, name)) env.delete(laid);
    }

    if (value !== undefined) env.set(name, value);
  }

  return Object.fromEntries(env);
}

function spawnAsyncAs(
  argv: Argv,
  options: RunOptions,
  env: Env,
): Promise<RunResult<string | Buffer>> {
  return options.stdout === "buffer"
    ? spawnAsync(argv, options, env, (bytes) => bytes, Buffer.alloc(0))
    : spawnAsync(argv, options, env, (bytes) => UTF8.decode(bytes), "");
}

function spawnSyncAs(argv: Argv, options: RunOptions, env: Env): RunResult<string | Buffer> {
  return options.stdout === "buffer"
    ? spawnSync(argv, options, env, (bytes) => bytes, Buffer.alloc(0))
    : spawnSync(argv, options, env, (bytes) => UTF8.decode(bytes), "");
}

/**
 * Runs `argv` to its end, its output captured: `exited` with its code, `timedOut` when
 * `timeoutMs` passed and the process was killed (`SIGKILL`), `missing` when the program is not on
 * the PATH. Any other failure to start (a missing `cwd`, a path to no program) throws a
 * `LaunchError`. After the exit, the output is waited for `OUTPUT_GRACE_MS` at most, then its pipes
 * are let go of: a killed shell's children may hold them. Past the grace, stdout and stderr are
 * both empty, even when one pipe had delivered its bytes, and the result carries
 * `outputLost: true`. The environment is this process's, `env` laid over it.
 */
export function run(argv: Argv, options: RunOptions & BufferOutput): Promise<RunResult<Buffer>>;
export function run(argv: Argv, options?: RunOptions & TextOutput): Promise<RunResult>;
export function run(argv: Argv, options: RunOptions = {}): Promise<RunResult<string | Buffer>> {
  return spawnAsyncAs(argv, options, overlaid(process.env, options.env));
}

/**
 * `run`, waiting in this thread; no grace period: the call returns once every pipe closes, so
 * `outputLost` is never set. A timeout is Bun's own flag on the result, so a process killed from
 * outside is `exited`.
 */
export function runSync(argv: Argv, options: RunOptions & BufferOutput): RunResult<Buffer>;
export function runSync(argv: Argv, options?: RunOptions & TextOutput): RunResult;
export function runSync(argv: Argv, options: RunOptions = {}): RunResult<string | Buffer> {
  return spawnSyncAs(argv, options, overlaid(process.env, options.env));
}

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
