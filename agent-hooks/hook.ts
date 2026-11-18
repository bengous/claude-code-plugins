/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- this module is the hook payload's boundary: Claude Code's JSON arrives on stdin, `parseInput` turns it into `Input`, and only `tool_input`, the tool's own shape, travels on as a record to be handed back as `updatedInput`. */
import type { BackgroundTaskSummary } from "@anthropic-ai/claude-agent-sdk";

import { realPathOf } from "./checkout.ts";
import type { Deadline, Runner } from "./core/util/exec.ts";
import { OUTPUT_GRACE_MS, deadlineIn } from "./core/util/exec.ts";
import { isRecord, recordField, stringField } from "./core/util/json.ts";

export const HOOK_KINDS = ["session-start", "pre-edit", "stop"] as const;

export type HookKind = (typeof HOOK_KINDS)[number];

export const DEADLINES_MS: Readonly<Record<HookKind, number>> = {
  "session-start": 4000,
  "pre-edit": 25_000,
  stop: 200_000,
};

/** SessionStart removes a scratch directory older than this: a pre-edit's own lives at most its deadline. */
export const SCRATCH_STALE_MS = DEADLINES_MS["pre-edit"];

/**
 * How long doctor lets a fixer run on its scratch copy: half the age at which SessionStart removes the copy, so a
 * concurrent SessionStart never removes it, a killed fixer's output grace included.
 */
export const PROBE_TIMEOUT_MS = SCRATCH_STALE_MS / 2;

/** A killed command's output grace, then the time to blame, record and encode the run. */
const SETTLE_MS = OUTPUT_GRACE_MS + 500;

export type Verdict =
  | { readonly kind: "allow" }
  /** Passes; `systemMessage`, shown to the user. */
  | { readonly kind: "note"; readonly text: string }
  /** The Stop's `decision: "block"`, its reason read by the agent. */
  | { readonly kind: "block"; readonly reason: string }
  | {
      readonly kind: "rewrite";
      // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- updatedInput is the tool's own tool_input, handed back whole: the kit reads none of its fields.
      readonly updatedInput: Record<string, unknown>;
      readonly text: string;
    };

export const ALLOW: Verdict = { kind: "allow" };

/** The fields of a hook payload the kit reads, checked by hand: `tool_input` is `unknown` in the SDK. */
export type Input = {
  readonly sessionId: string;
  /** Set only when the hook fires inside a subagent, its tool calls and its SubagentStop alike. */
  readonly agentId: string | undefined;
  /** The payload's cwd with its symlinks resolved: the path git would name. */
  readonly cwd: string | undefined;
  readonly promptId: string | undefined;
  readonly permissionMode: string | undefined;
  readonly backgroundTasks: readonly BackgroundTaskSummary[];
  readonly toolName: string | undefined;
  readonly toolInput: Record<string, unknown>;
};

/** What a hook runs with besides its payload; the tests set the runner, the clock and a shorter deadline. */
export type HookOptions = {
  readonly runner: Runner;
  readonly now: number;
  readonly deadlineMs?: number;
};

export type Handler = (input: Input, options: HookOptions) => Promise<Verdict | null>;

export function isHookKind(value: string | undefined): value is HookKind {
  return HOOK_KINDS.some((hook) => hook === value);
}

export async function readPayload(): Promise<unknown> {
  const text = await Bun.stdin.text();

  try {
    const parsed: unknown = JSON.parse(text);

    return parsed;
  } catch {
    return null;
  }
}

export function parseInput(payload: unknown): Input | null {
  if (!isRecord(payload)) {
    return null;
  }

  const sessionId = stringField(payload, "session_id");

  if (sessionId === undefined || sessionId === "") {
    return null;
  }

  const tasks = payload["background_tasks"];
  const cwd = stringField(payload, "cwd");

  return {
    sessionId,
    agentId: stringField(payload, "agent_id"),
    cwd: cwd === undefined ? undefined : realPathOf(cwd),
    promptId: stringField(payload, "prompt_id"),
    permissionMode: stringField(payload, "permission_mode"),
    backgroundTasks: Array.isArray(tasks) ? tasks.filter((task) => isBackgroundTask(task)) : [],
    toolName: stringField(payload, "tool_name"),
    toolInput: recordField(payload, "tool_input") ?? {},
  };
}

function isBackgroundTask(value: unknown): value is BackgroundTaskSummary {
  return (
    isRecord(value) &&
    typeof value["id"] === "string" &&
    typeof value["type"] === "string" &&
    typeof value["status"] === "string" &&
    typeof value["description"] === "string"
  );
}

/**
 * Runs `body` against the hook's deadline. The fixers, lanes and git calls get the deadline minus SETTLE_MS, so a
 * killed command reports its timeout before the race gives up on the whole run, which then throws.
 */
export async function raced<T>(
  hook: HookKind,
  options: HookOptions,
  body: (deadline: Deadline) => Promise<T>,
): Promise<T> {
  const deadlineMs = options.deadlineMs ?? DEADLINES_MS[hook];
  const remaining = deadlineIn(deadlineMs, options.now).remaining();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const past = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${hook} ran past its ${deadlineMs} ms deadline`)),
      remaining,
    );
  });

  try {
    return await Promise.race([
      body(deadlineIn(Math.max(0, deadlineMs - SETTLE_MS), options.now)),
      past,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The wire shape of a verdict for Claude Code, or null for no output. */
export function encode(verdict: Verdict): string | null {
  switch (verdict.kind) {
    case "allow": {
      return null;
    }

    case "note": {
      return JSON.stringify({ systemMessage: verdict.text });
    }

    case "block": {
      return JSON.stringify({ decision: "block", reason: verdict.reason });
    }

    case "rewrite": {
      return JSON.stringify({
        hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: verdict.updatedInput },
        systemMessage: verdict.text,
      });
    }

    default: {
      const unreachable: never = verdict;
      throw new Error(`unhandled verdict: ${JSON.stringify(unreachable)}`);
    }
  }
}
