/**
 * Claude CLI SDK - Core functions for programmatic agent spawning.
 *
 * @example
 * ```typescript
 * import { spawn, readHookInput } from "./_shared/claude-cli";
 *
 * const input = readHookInput();
 * const result = spawn({ prompt: "Analyze this code", maxTurns: 5 });
 *
 * if (result.ok) {
 *   console.log(result.result);
 * }
 * ```
 */

import { readFileSync } from "fs";
import type {
  HookInput,
  SpawnOptions,
  AgentResult,
  CliJsonOutput,
} from "./types";

export * from "./types";
export * from "./presets";

/** Default timeout: 55 seconds (under 60s hook limit) */
const DEFAULT_TIMEOUT = 55_000;

/** Required fields for HookInput validation */
const HOOK_INPUT_REQUIRED_FIELDS = [
  "session_id",
  "transcript_path",
  "cwd",
  "hook_event_name",
] as const;

/**
 * Validate that an object has the required HookInput fields.
 * @internal
 */
function isValidHookInput(obj: unknown): obj is HookInput {
  if (typeof obj !== "object" || obj === null) return false;
  const record = obj as Record<string, unknown>;
  return HOOK_INPUT_REQUIRED_FIELDS.every(
    (field) => typeof record[field] === "string"
  );
}

/**
 * Read and parse hook input from stdin.
 * Returns null if stdin is empty, not valid JSON, or missing required fields.
 *
 * @example
 * ```typescript
 * const input = readHookInput();
 * if (!input || input.tool_name !== "Bash") {
 *   process.exit(0);  // Not our hook event
 * }
 * ```
 */
export function readHookInput(): HookInput | null {
  try {
    // Use Node.js fs for synchronous stdin reading (fd 0)
    // Bun.stdin is async-only; this is the recommended sync approach
    const text = readFileSync(0, "utf-8");
    if (!text.trim()) return null;

    const parsed = JSON.parse(text);
    if (!isValidHookInput(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Spawn a Claude agent and wait for the result.
 * Uses `Bun.spawnSync` for synchronous execution (required for hooks).
 *
 * @param options - Spawn configuration
 * @returns AgentResult - Either AgentSuccess or AgentFailure
 *
 * @example
 * ```typescript
 * const result = spawn({
 *   prompt: "Is this code safe?",
 *   allowedTools: ["Read", "Grep"],
 *   maxTurns: 3,
 * });
 *
 * if (result.ok) {
 *   console.log(result.result);
 *   console.log(`Cost: $${result.totalCostUsd}`);
 * } else {
 *   console.error(result.error);
 * }
 * ```
 */
export function spawn(options: SpawnOptions): AgentResult {
  const args = buildCliArgs(options);
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;

  const proc = Bun.spawnSync(["claude", ...args], {
    cwd: options.cwd ?? process.cwd(),
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
    timeout,
  });

  const stdout = proc.stdout.toString();
  const stderr = proc.stderr.toString();

  // Handle timeout (check first - Bun provides explicit flag)
  if (proc.exitedDueToTimeout) {
    return {
      ok: false,
      error: `Claude CLI timed out after ${timeout}ms`,
      exitCode: 124, // Standard timeout exit code
      stderr,
      timedOut: true,
    };
  }

  // Handle non-zero exit
  if (proc.exitCode !== 0) {
    return {
      ok: false,
      error: `Claude CLI exited with code ${proc.exitCode}`,
      exitCode: proc.exitCode ?? 1,
      stderr,
      signalCode: proc.signalCode ?? undefined,
    };
  }

  // Parse JSON output
  try {
    const output = JSON.parse(stdout) as CliJsonOutput;

    if (output.is_error || output.subtype === "error") {
      return {
        ok: false,
        error: output.result || "Unknown error from Claude CLI",
        exitCode: 1,
        stderr,
      };
    }

    return {
      ok: true,
      result: output.result,
      sessionId: output.session_id,
      totalCostUsd: output.total_cost_usd,
      durationMs: output.duration_ms,
      numTurns: output.num_turns,
      uuid: output.uuid,
    };
  } catch {
    // JSON parse failed - return raw output as error
    return {
      ok: false,
      error: stdout || "Failed to parse Claude CLI output",
      exitCode: proc.exitCode ?? 1,
      stderr,
    };
  }
}

/**
 * Build CLI arguments from SpawnOptions.
 * @internal
 */
function buildCliArgs(options: SpawnOptions): string[] {
  const args: string[] = [
    "-p",
    options.prompt,
    "--output-format",
    "json",
  ];

  // Session handling
  if (options.sessionId) {
    args.push("--resume", options.sessionId);
  }
  if (options.newSessionId) {
    args.push("--session-id", options.newSessionId);
  }
  if (options.noSessionPersistence) {
    args.push("--no-session-persistence");
  }

  // Model
  if (options.model) {
    args.push("--model", options.model);
  }

  // Tools
  if (options.allowedTools?.length) {
    args.push("--allowedTools", ...options.allowedTools);
  }
  if (options.disallowedTools?.length) {
    args.push("--disallowedTools", ...options.disallowedTools);
  }

  // System prompt (append, don't replace)
  if (options.systemPrompt) {
    args.push("--append-system-prompt", options.systemPrompt);
  }

  // Limits
  if (options.maxTurns !== undefined) {
    args.push("--max-turns", String(options.maxTurns));
  }
  if (options.maxBudgetUsd !== undefined) {
    args.push("--max-budget-usd", String(options.maxBudgetUsd));
  }

  // Permissions
  if (options.permissionMode) {
    args.push("--permission-mode", options.permissionMode);
  }

  // Structured output
  if (options.jsonSchema) {
    args.push("--json-schema", JSON.stringify(options.jsonSchema));
  }

  return args;
}
