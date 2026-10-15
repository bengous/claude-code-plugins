import { existsSync } from "node:fs";
import path from "node:path";

export type Argv = readonly [program: string, ...args: string[]];

export type RunOptions = {
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly stdin?: string;
};

export type RunResult =
  | {
      readonly kind: "exited";
      readonly code: number;
      readonly stdout: string;
      readonly stderr: string;
    }
  | {
      readonly kind: "timedOut";
      readonly timeoutMs: number;
      readonly stdout: string;
      readonly stderr: string;
    }
  | { readonly kind: "missing"; readonly program: string };

export type Runner = (argv: Argv, options: RunOptions) => Promise<RunResult>;

export type Deadline = {
  /** Milliseconds left, never negative. */
  readonly remaining: () => number;
};

export const OUTPUT_TAIL_LINES = 40;

export function deadlineIn(ms: number, start = Date.now()): Deadline {
  const at = start + ms;

  return { remaining: () => Math.max(0, at - Date.now()) };
}

export async function run(argv: Argv, options: RunOptions): Promise<RunResult> {
  if (options.timeoutMs <= 0) {
    return { kind: "timedOut", timeoutMs: options.timeoutMs, stdout: "", stderr: "" };
  }

  let proc: Bun.Subprocess<"ignore" | Response, "pipe", "pipe">;

  try {
    proc = Bun.spawn([...argv], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdin: options.stdin === undefined ? "ignore" : new Response(options.stdin),
      stdout: "pipe",
      stderr: "pipe",
      timeout: options.timeoutMs,
      killSignal: "SIGKILL",
    });
  } catch {
    return { kind: "missing", program: argv[0] };
  }

  const output = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  // A killed shell leaves its children holding the pipes: wait for the output only as long as the grace period.
  const [stdout, stderr] = (await Promise.race([output, abandonedOutput()])) ?? ["", ""];

  // An async Subprocess carries no timeout flag, so the kill signal we asked for is the only evidence Bun cut it short.
  return proc.signalCode === "SIGKILL"
    ? { kind: "timedOut", timeoutMs: options.timeoutMs, stdout, stderr }
    : { kind: "exited", code, stdout, stderr };
}

const OUTPUT_GRACE_MS = 1000;

async function abandonedOutput(): Promise<null> {
  await Bun.sleep(OUTPUT_GRACE_MS);

  return null;
}

export function succeeded(result: RunResult): boolean {
  return result.kind === "exited" && result.code === 0;
}

/** Resolves a command name the way a package script would: the package's bin dir, then the root's, then PATH. */
export function resolveProgram(name: string, pkg: string, root: string): string | null {
  if (name.includes("/")) {
    const absolute = path.resolve(root, name);

    return existsSync(absolute) ? absolute : null;
  }

  for (const dir of [pkg, root]) {
    const candidate = path.join(dir, "node_modules", ".bin", name);

    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return Bun.which(name, { PATH: process.env["PATH"] ?? "" });
}

export function outputOf(result: RunResult): string {
  if (result.kind === "missing") {
    return `command not found: ${result.program}`;
  }

  return [result.stderr, result.stdout]
    .filter((part) => part.trim() !== "")
    .join("\n")
    .trim();
}

export function formatFailure(label: string, result: RunResult, lines = OUTPUT_TAIL_LINES): string {
  const output = outputOf(result);

  switch (result.kind) {
    case "missing": {
      return `${label}: ${output}`;
    }

    case "timedOut": {
      const headline = `${label} timed out after ${result.timeoutMs} ms`;

      return output === "" ? headline : `${headline}\n${tail(output, lines)}`;
    }

    case "exited": {
      return output === ""
        ? `${label} exited with code ${result.code}`
        : `${label}\n${tail(output, lines)}`;
    }

    default: {
      const unreachable: never = result;
      throw new Error(`unhandled result: ${JSON.stringify(unreachable)}`);
    }
  }
}

export function tail(text: string, lines: number): string {
  return text.trim().split(/\r?\n/u).filter(Boolean).slice(-lines).join("\n");
}
