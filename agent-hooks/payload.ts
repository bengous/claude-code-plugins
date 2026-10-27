/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-returns -- this module is the hook payload's boundary: the harness's JSON arrives on stdin, `parseInput` turns it into `Input`, and only `tool_input`, the harness's per-tool shape, travels on as a record to be handed back as `updatedInput`. */
import type { BackgroundTaskSummary } from "@anthropic-ai/claude-agent-sdk";

import { isRecord, recordField, stringField } from "./json.ts";
import { realPathOf } from "./scope.ts";

/** The fields of a hook payload the kit reads, checked by hand: `tool_input` is `unknown` in the SDK. */
export type Input = {
  readonly sessionId: string;
  /** Set only when the hook fires inside a subagent, its tool calls and its SubagentStop alike. */
  readonly agentId: string | undefined;
  /** The payload's cwd with its symlinks resolved: the path git would name. */
  readonly cwd: string | undefined;
  /** `prompt_id` under Claude Code, `turn_id` under Codex. */
  readonly promptId: string | undefined;
  /** How a session started, at SessionStart: `startup`, `resume`, `clear`, `compact` or `fork`. */
  readonly source: string | undefined;
  readonly permissionMode: string | undefined;
  readonly backgroundTasks: readonly BackgroundTaskSummary[];
  readonly toolName: string | undefined;
  readonly toolInput: Record<string, unknown>;
  /** The main session's transcript, a subagent's tool calls included. */
  readonly transcriptPath: string | undefined;
};

export async function readPayload(): Promise<unknown> {
  const text = await Bun.stdin.text();

  if (text.trim() === "") {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(text);

    return parsed;
  } catch {
    return null;
  }
}

export function parseInput(payload: Record<string, unknown>): Input | null {
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
    promptId: stringField(payload, "prompt_id") ?? stringField(payload, "turn_id"),
    source: stringField(payload, "source"),
    permissionMode: stringField(payload, "permission_mode"),
    backgroundTasks: Array.isArray(tasks) ? tasks.filter((task) => isBackgroundTask(task)) : [],
    toolName: stringField(payload, "tool_name"),
    toolInput: recordField(payload, "tool_input") ?? {},
    transcriptPath: stringField(payload, "transcript_path"),
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
