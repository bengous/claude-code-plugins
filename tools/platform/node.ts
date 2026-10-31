import { linkSync, mkdirSync, renameSync as fsRenameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, open, readFile, rename as fsRename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:os";
import { basename, dirname, join } from "node:path";

import { isErrno } from "./pure.ts";

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
 * concurrent writer is what this guards against, not a power loss.
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

async function heldLockError(lockFile: string, timeoutMs: number): Promise<Error> {
  const text = await readFile(lockFile, "utf8").catch((cause: unknown) => {
    if (isErrno(cause, "ENOENT")) return "";
    throw cause;
  });

  const [, pid, since] = LOCK_HOLDER.exec(text.trim()) ?? [];
  const age = since === undefined ? Number.NaN : Date.now() - Date.parse(since);
  const holder = pid === undefined ? "an unknown holder" : `pid ${pid}`;
  const held = Number.isNaN(age) ? "" : ` for ${age} ms`;

  return new Error(
    `${lockFile} is still locked after ${timeoutMs} ms, by ${holder}${held}; if no such process runs, remove the lock file`,
  );
}

/** Creates the lock file with this process's pid and the date; `false` when another holds it. */
async function tryLock(lockFile: string): Promise<boolean> {
  const handle = await open(lockFile, "wx").catch((cause: unknown) => {
    if (isErrno(cause, "EEXIST")) return null;
    throw cause;
  });

  if (handle === null) return false;

  try {
    await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`);
  } catch (cause) {
    await handle.close();
    await rm(lockFile, { force: true });
    throw cause;
  }

  await handle.close();

  return true;
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
  const until = Date.now() + options.timeoutMs;

  while (!(await tryLock(lockFile))) {
    if (Date.now() >= until) throw await heldLockError(lockFile, options.timeoutMs);
    await Bun.sleep(LOCK_POLL_MS);
  }

  try {
    return await fn();
  } finally {
    await rm(lockFile, { force: true });
  }
}

export type Argv = readonly [program: string, ...args: string[]];

export type RunOptions = {
  /** The process's directory; this process's own by default. */
  readonly cwd?: string;
  /** Variables laid over this process's environment, which the child gets in full. */
  readonly env?: Readonly<Record<string, string>>;
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
    }
  | {
      readonly kind: "timedOut";
      readonly timeoutMs: number;
      readonly stdout: Out;
      readonly stderr: string;
    }
  | { readonly kind: "missing"; readonly program: string };

/** The output a killed shell's children may keep holding is waited for this long after the exit. */
export const OUTPUT_GRACE_MS = 1000;

/** Bun's words for a program it cannot find on the PATH; any other spawn failure (a missing cwd) is thrown. */
const NOT_FOUND = /^Executable not found/u;

function isNotFound(cause: unknown): boolean {
  return cause instanceof Error && NOT_FOUND.test(cause.message);
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

async function abandonedOutput(): Promise<null> {
  await Bun.sleep(OUTPUT_GRACE_MS);

  return null;
}

async function spawnAsync<Out>(
  argv: Argv,
  options: RunOptions,
  env: Env,
  read: (stream: ReadableStream<Uint8Array>) => Promise<Out>,
  empty: Out,
): Promise<RunResult<Out>> {
  if (options.timeoutMs !== undefined && options.timeoutMs <= 0) {
    return { kind: "timedOut", timeoutMs: options.timeoutMs, stdout: empty, stderr: "" };
  }

  let proc: Bun.Subprocess<"ignore" | Response, "pipe", "pipe">;

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
    throw cause;
  }

  const output = Promise.all([read(proc.stdout), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  // A killed shell leaves its children holding the pipes: wait for the output only as long as the grace period.
  const [stdout, stderr] = (await Promise.race([output, abandonedOutput()])) ?? [empty, ""];

  // An async Subprocess carries no timeout flag, so the kill signal we asked for is the only evidence Bun cut it short.
  return options.timeoutMs !== undefined && proc.signalCode === "SIGKILL"
    ? { kind: "timedOut", timeoutMs: options.timeoutMs, stdout, stderr }
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
    throw cause;
  }

  const stdout = read(result.stdout);
  const stderr = result.stderr.toString();

  if (options.timeoutMs !== undefined && result.signalCode === "SIGKILL") {
    return { kind: "timedOut", timeoutMs: options.timeoutMs, stdout, stderr };
  }

  const code =
    result.signalCode === undefined ? result.exitCode : signalExitCode(result.signalCode);

  return { kind: "exited", code, stdout, stderr };
}

function overlaid(base: Env, env: Readonly<Record<string, string>> | undefined) {
  return { ...base, ...env };
}

const readText = (stream: ReadableStream<Uint8Array>): Promise<string> =>
  new Response(stream).text();

const readBuffer = async (stream: ReadableStream<Uint8Array>): Promise<Buffer> =>
  Buffer.from(await new Response(stream).arrayBuffer());

function spawnAsyncAs(
  argv: Argv,
  options: RunOptions,
  env: Env,
): Promise<RunResult<string | Buffer>> {
  return options.stdout === "buffer"
    ? spawnAsync(argv, options, env, readBuffer, Buffer.alloc(0))
    : spawnAsync(argv, options, env, readText, "");
}

function spawnSyncAs(argv: Argv, options: RunOptions, env: Env): RunResult<string | Buffer> {
  return options.stdout === "buffer"
    ? spawnSync(argv, options, env, (bytes) => bytes, Buffer.alloc(0))
    : spawnSync(argv, options, env, (bytes) => bytes.toString(), "");
}

/**
 * Runs `argv` to its end, its output captured: `exited` with its code, `timedOut` when
 * `timeoutMs` passed and the process was killed (`SIGKILL`), `missing` when the program is not on
 * the PATH. Any other failure to start (a missing `cwd`) is thrown. After the exit, the output is
 * waited for `OUTPUT_GRACE_MS` at most, then answered empty: a killed shell's children may hold
 * its pipes. The environment is this process's, `env` laid over it.
 */
export function run(argv: Argv, options: RunOptions & BufferOutput): Promise<RunResult<Buffer>>;
export function run(argv: Argv, options?: RunOptions & TextOutput): Promise<RunResult>;
export function run(argv: Argv, options: RunOptions = {}): Promise<RunResult<string | Buffer>> {
  return spawnAsyncAs(argv, options, overlaid(process.env, options.env));
}

/** `run`, waiting in this thread; no grace period: the call returns once every pipe closes. */
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
  const env = overlaid(base, options.env);

  return options.cLocale === true ? { ...env, LC_ALL: "C" } : env;
}

function withoutGitVariables(env: Env): Env {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith("GIT_")));
}

function gitArgv(args: readonly string[], options: GitOptions): Argv {
  return ["git", ...(options.config ?? []).flatMap((entry) => ["-c", entry]), ...args];
}

function found<Out>(result: RunResult<Out>): GitResult<Out> {
  if (result.kind === "missing") throw new Error("git is not on the PATH");

  return result;
}

/**
 * Runs git through `run`, its output raw, untrimmed. A git missing from the PATH throws. `cwd` is
 * an option; a call that names its repository with `-C` keeps it in `args`.
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

/** A git command that did not exit 0: `git <args> failed (exit <code>): <stderr>`, or timed out. */
export class GitError extends Error {
  override readonly name = "GitError";

  readonly args: readonly string[];

  readonly result: GitResult;

  constructor(args: readonly string[], result: GitResult) {
    const command = `git ${args.join(" ")}`;

    super(
      result.kind === "exited"
        ? `${command} failed (exit ${result.code}): ${result.stderr.trim()}`
        : `${command} timed out after ${result.timeoutMs} ms: ${result.stderr.trim()}`,
    );
    this.args = args;
    this.result = result;
  }
}

export type GitReadOptions = Omit<GitOptions, "stdout">;

function readOf(args: readonly string[], result: GitResult): string {
  if (result.kind !== "exited" || result.code !== 0) throw new GitError(args, result);

  return result.stdout.trim();
}

/** A git command that must succeed: its stdout trimmed; any other end throws a `GitError`. */
export async function gitRead(
  args: readonly string[],
  options: GitReadOptions = {},
): Promise<string> {
  return readOf(args, await git(args, options));
}

export function gitReadSync(args: readonly string[], options: GitReadOptions = {}): string {
  return readOf(args, gitSync(args, options));
}
