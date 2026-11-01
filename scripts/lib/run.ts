import {
  type Argv,
  type BufferOutput,
  type RunOptions,
  runSync,
} from "../../tools/platform/process.ts";

/** A finished command: whether it exited 0, its stdout as bytes and trimmed, its stderr trimmed. */
export interface Run {
  readonly ok: boolean;
  readonly raw: Uint8Array;
  readonly out: string;
  readonly err: string;
}

/** A finished command as it ended: its exit code, its stdout as bytes, its stderr untrimmed. */
export interface Ran {
  readonly code: number;
  readonly raw: Buffer;
  readonly err: string;
}

function argvOf(cmd: readonly string[]): Argv {
  const [program, ...args] = cmd;

  if (program === undefined) throw new TypeError("cmd must not be empty");

  return [program, ...args];
}

/** Runs `cmd` in `cwd` to its end, `stdin` fed to it when given; a program the PATH lacks throws. */
export function runRaw(cmd: readonly string[], cwd: string, stdin?: string | Uint8Array): Ran {
  const argv = argvOf(cmd);

  const options: RunOptions & BufferOutput =
    stdin === undefined ? { cwd, stdout: "buffer" } : { cwd, stdout: "buffer", stdin };

  const result = runSync(argv, options);

  if (result.kind === "missing") {
    throw new Error(`Executable not found in $PATH: "${result.program}"`);
  }

  if (result.kind === "timedOut") {
    throw new Error(`${argv[0]} timed out after ${result.timeoutMs} ms`);
  }

  return { code: result.code, raw: result.stdout, err: result.stderr };
}

/** Runs `cmd` in `cwd` to its end, `stdin` fed to it when given; a program the PATH lacks throws. */
export function run(cmd: readonly string[], cwd: string, stdin?: Uint8Array): Run {
  const { code, raw, err } = runRaw(cmd, cwd, stdin);

  return { ok: code === 0, raw, out: raw.toString().trim(), err: err.trim() };
}
