import { constants } from "node:os";

import { errnoOf, messageOf } from "./pure.ts";

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
 * `cwd`, a path to no program on POSIX, a program it may not run (`EACCES`). It keeps Bun's
 * message, Bun's error as `cause`, and its errno as `code`, so `errnoOf` reads what it read off
 * Bun's error.
 */
export class LaunchError extends Error {
  override readonly name = "LaunchError";

  readonly code: string | undefined;

  constructor(cause: unknown) {
    super(messageOf(cause), { cause });
    this.code = errnoOf(cause) ?? undefined;
  }
}

export type Env = Readonly<Record<string, string | undefined>>;

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
export const sameName =
  process.platform === "win32"
    ? (a: string, b: string): boolean => a.toUpperCase() === b.toUpperCase()
    : (a: string, b: string): boolean => a === b;

/**
 * `base` with `overlay` laid over it, entry by entry: a value sets its variable, `undefined`
 * removes it, and each entry replaces every variable of the same name before it, the overlay's own.
 */
export function overlaid(base: Env, overlay: EnvOverlay = {}): Env {
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

/**
 * `run` with `env` as the child's whole environment, not laid over this process's: for a caller
 * that builds its own, as `git.ts` leaves out the `GIT_*` variables.
 */
export function spawnAsyncAs(
  argv: Argv,
  options: RunOptions,
  env: Env,
): Promise<RunResult<string | Buffer>> {
  return options.stdout === "buffer"
    ? spawnAsync(argv, options, env, (bytes) => bytes, Buffer.alloc(0))
    : spawnAsync(argv, options, env, (bytes) => UTF8.decode(bytes), "");
}

/** `runSync` with `env` as the child's whole environment, as `spawnAsyncAs` takes it. */
export function spawnSyncAs(argv: Argv, options: RunOptions, env: Env): RunResult<string | Buffer> {
  return options.stdout === "buffer"
    ? spawnSync(argv, options, env, (bytes) => bytes, Buffer.alloc(0))
    : spawnSync(argv, options, env, (bytes) => UTF8.decode(bytes), "");
}

/**
 * Runs `argv` to its end, its output captured: `exited` with its code, `timedOut` when
 * `timeoutMs` passed and the process was killed (`SIGKILL`), `missing` when the program is not on
 * the PATH. Any other failure to start (a missing `cwd`, a path to no program on POSIX) throws a
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
