import { existsSync } from "node:fs";
import path from "node:path";

import type { Argv, RunResult as ProcessResult } from "./lib/platform/process.ts";
import { LaunchError, run as runProcess } from "./lib/platform/process.ts";

export type { Argv } from "./lib/platform/process.ts";

export { OUTPUT_GRACE_MS } from "./lib/platform/process.ts";

export type RunOptions = {
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly stdin?: string;
};

export type RunResult = ProcessResult;

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

/**
 * The platform's `run`, where a program that cannot start is `missing` whatever stops it: a name the PATH does not
 * hold, a path to no program, a program it may not run, or a cwd gone from disk, which the landing guard derives
 * from the command it reads. Any other throw is no failed start, and goes up.
 */
export async function run(argv: Argv, options: RunOptions): Promise<RunResult> {
  try {
    return await runProcess(argv, options);
  } catch (cause) {
    if (cause instanceof LaunchError) return { kind: "missing", program: argv[0] };
    throw cause;
  }
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
