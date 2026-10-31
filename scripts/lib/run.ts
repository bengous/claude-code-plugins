import {
  type Argv,
  type BufferOutput,
  type RunOptions,
  runSync,
} from "../../tools/platform/node.ts";

/** A finished command: whether it exited 0, its stdout as bytes and trimmed, its stderr trimmed. */
export interface Run {
  readonly ok: boolean;
  readonly raw: Uint8Array;
  readonly out: string;
  readonly err: string;
}

function argvOf(cmd: readonly string[]): Argv {
  const [program, ...args] = cmd;

  if (program === undefined) throw new TypeError("cmd must not be empty");

  return [program, ...args];
}

/** Runs `cmd` in `cwd` to its end, `stdin` fed to it when given; a program the PATH lacks throws. */
export function run(cmd: readonly string[], cwd: string, stdin?: Uint8Array): Run {
  const options: RunOptions & BufferOutput =
    stdin === undefined ? { cwd, stdout: "buffer" } : { cwd, stdout: "buffer", stdin };

  const result = runSync(argvOf(cmd), options);

  if (result.kind === "missing") {
    throw new Error(`Executable not found in $PATH: "${result.program}"`);
  }

  return {
    ok: result.kind === "exited" && result.code === 0,
    raw: result.stdout,
    out: result.stdout.toString().trim(),
    err: result.stderr.trim(),
  };
}
