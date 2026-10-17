/** A finished command: whether it exited 0, its stdout as bytes and trimmed, its stderr trimmed. */
export interface Run {
  readonly ok: boolean;
  readonly raw: Uint8Array;
  readonly out: string;
  readonly err: string;
}

/** Runs `cmd` in `cwd` to its end, `stdin` fed to it when given. */
export function run(cmd: readonly string[], cwd: string, stdin?: Uint8Array): Run {
  const result = Bun.spawnSync([...cmd], {
    cwd,
    env: process.env,
    stdin: stdin ?? null,
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    ok: result.exitCode === 0,
    raw: result.stdout,
    out: result.stdout.toString().trim(),
    err: result.stderr.toString().trim(),
  };
}
