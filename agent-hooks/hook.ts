/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-returns -- this module is the hook payload's boundary: the harness's JSON arrives on stdin, `parseInput` turns it into `Input`, and only `tool_input`, the harness's per-tool shape, travels on as a record to be handed back as `updatedInput`. */
import { existsSync } from "node:fs";
import path from "node:path";

import type { BackgroundTaskSummary } from "@anthropic-ai/claude-agent-sdk";

import type { Config } from "./config.ts";
import { ConfigError, DEFAULT_CAP, configPath, loadConfig } from "./config.ts";
import type { Deadline, Runner } from "./exec.ts";
import { OUTPUT_GRACE_MS, deadlineIn, run } from "./exec.ts";
import { booleanField, isRecord, recordField, stringField } from "./json.ts";
import { CRASH_LANE, guard } from "./loop-guard.ts";
import { findRoot } from "./scope.ts";
import type { SessionState } from "./state.ts";
import { freshState, loadState, saveState, statesOf } from "./state.ts";

export const HARNESSES = ["claude", "codex"] as const;

export type Harness = (typeof HARNESSES)[number];

export const HOOK_KINDS = ["session-start", "pre-edit", "post-edit", "stop"] as const;

export type HookKind = (typeof HOOK_KINDS)[number];

export const DEADLINES_MS: Readonly<Record<HookKind, number>> = {
  "session-start": 4000,
  "pre-edit": 25_000,
  "post-edit": 50_000,
  stop: 200_000,
};

/** A killed command's output grace, then the time to blame, record and encode the run. */
const SETTLE_MS = OUTPUT_GRACE_MS + 500;

export type Verdict =
  | { readonly kind: "allow" }
  /** Passes; `systemMessage`, shown to the user. */
  | { readonly kind: "note"; readonly text: string }
  /** Passes; `additionalContext`, read by the agent. */
  | { readonly kind: "context"; readonly text: string }
  | { readonly kind: "block"; readonly reason: string }
  | {
      readonly kind: "rewrite";
      readonly updatedInput: Record<string, unknown>;
      readonly text: string;
    };

export const ALLOW: Verdict = { kind: "allow" };

/** The fields of a hook payload the kit reads, checked by hand: `tool_input` is `unknown` in the SDK. */
export type Input = {
  readonly sessionId: string;
  /** Set only when the hook fires inside a subagent, its tool calls and its SubagentStop alike. */
  readonly agentId: string | undefined;
  readonly cwd: string | undefined;
  /** `prompt_id` under Claude Code, `turn_id` under Codex. */
  readonly promptId: string | undefined;
  readonly permissionMode: string | undefined;
  readonly stopHookActive: boolean;
  readonly backgroundTasks: readonly BackgroundTaskSummary[];
  readonly toolName: string | undefined;
  readonly toolInput: Record<string, unknown>;
};

export type HookContext = {
  readonly hook: HookKind;
  readonly harness: Harness;
  readonly input: Input;
  readonly root: string;
  readonly config: Config;
  readonly state: SessionState;
  readonly deadline: Deadline;
  readonly runner: Runner;
};

export type Handler = (context: HookContext) => Promise<Verdict>;

export type RunHookOptions = {
  readonly hook: HookKind;
  readonly harness: Harness;
  readonly payload: unknown;
  readonly handler: Handler;
  readonly runner?: Runner;
  readonly now?: number;
  /** Overrides DEADLINES_MS for the tests. */
  readonly deadlineMs?: number;
};

export function isHarness(value: string | undefined): value is Harness {
  return HARNESSES.some((harness) => harness === value);
}

export function isHookKind(value: string | undefined): value is HookKind {
  return HOOK_KINDS.some((hook) => hook === value);
}

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

  return {
    sessionId,
    agentId: stringField(payload, "agent_id"),
    cwd: stringField(payload, "cwd"),
    promptId: stringField(payload, "prompt_id") ?? stringField(payload, "turn_id"),
    permissionMode: stringField(payload, "permission_mode"),
    stopHookActive: booleanField(payload, "stop_hook_active") ?? false,
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

/** Where the root search starts: the edited file's directory for the edit hooks, the payload's cwd otherwise. */
export function searchStart(hook: HookKind, input: Input): string | null {
  if (hook === "pre-edit" || hook === "post-edit") {
    const filePath = stringField(input.toolInput, "file_path");

    if (filePath !== undefined) {
      return path.dirname(path.resolve(input.cwd ?? process.cwd(), filePath));
    }
  }

  return input.cwd ?? null;
}

/**
 * The envelope every hook runs in: reads the payload, finds the roots, loads the config and the state of each,
 * runs the handler under a deadline, saves the state and encodes the verdicts for the harness. Returns the line to
 * print, or null for no output. Never throws: a crash is a verdict too.
 */
export async function runHook(options: RunHookOptions): Promise<string | null> {
  const { hook, harness, payload } = options;

  if (!isRecord(payload)) {
    console.error("agent-hooks: empty or invalid payload on stdin");

    return null;
  }

  const input = parseInput(payload);

  if (input === null) {
    console.error("agent-hooks: payload has no session_id");

    return null;
  }

  const start = searchStart(hook, input);
  const now = options.now ?? Date.now();

  const states =
    hook === "stop"
      ? stopStates(input, start, now)
      : rootAt(start).map((root) => loadState(stateKey(input), root, now));

  if (states.length === 0) {
    return null;
  }

  const verdicts = await Promise.all(states.map((state) => runAt(options, input, state, now)));

  return encode(merged(verdicts), harness, hook);
}

function rootAt(start: string | null): string[] {
  const root = start === null ? null : findRoot(start);

  return root === null ? [] : [root];
}

/**
 * The roots a Stop checks: each one the session photographed, at its SessionStart or its first edit there, wherever
 * its cwd has moved since, and the root around its cwd, checked over its whole dirty tree when it has no photo:
 * Bash and a Codex patch photograph nothing, and checking too much beats missing a root. A subagent checks only the
 * roots it photographed: over a shared checkout's whole tree, one that edited nothing would block on its parent's
 * work.
 */
function stopStates(input: Input, start: string | null, now: number): SessionState[] {
  const key = stateKey(input);
  const saved = statesOf(key);

  const photographed = saved.filter(
    (state) => state.photo !== null && existsSync(configPath(state.root)),
  );

  const [cwdRoot] = rootAt(start);

  if (
    input.agentId !== undefined ||
    cwdRoot === undefined ||
    photographed.some((state) => state.root === cwdRoot)
  ) {
    return photographed;
  }

  const cwdState = saved.find((state) => state.root === cwdRoot) ?? freshState(key, cwdRoot, now);

  return [...photographed, cwdState].toSorted((left, right) =>
    left.root < right.root ? -1 : Number(left.root > right.root),
  );
}

/**
 * The name of the state a hook reads and writes: the session's, or for a subagent its own under the session, so two
 * subagents of one session keep their own photo, failing set and block counter.
 */
export function stateKey(input: Input): string {
  return input.agentId === undefined ? input.sessionId : `${input.sessionId}.${input.agentId}`;
}

type RootVerdict = { readonly root: string; readonly verdict: Verdict };

async function runAt(
  options: RunHookOptions,
  input: Input,
  state: SessionState,
  now: number,
): Promise<RootVerdict> {
  const hadPhoto = state.photo !== null;
  const verdict = await verdictOf(options, input, state.root, state, now);

  // An edit hook changes the state only when pre-edit photographs a root that had no photo: that alone decides its
  // save. A Stop or a session start always saves, which refreshes the state's age.
  if (!isEditHook(options.hook) || (!hadPhoto && state.photo !== null)) {
    persist(state, now);
  }

  return { root: state.root, verdict };
}

/** One root's verdict as it is; several roots name theirs, and one block among them blocks. */
function merged(verdicts: readonly RootVerdict[]): Verdict {
  const [only] = verdicts;

  if (only !== undefined && verdicts.length === 1) {
    return only.verdict;
  }

  const texts = verdicts.flatMap(({ root, verdict }) => {
    switch (verdict.kind) {
      case "block": {
        return [`${root}:\n${verdict.reason}`];
      }

      case "note": {
        return [`${root}:\n${verdict.text}`];
      }

      default: {
        return [];
      }
    }
  });

  if (verdicts.some(({ verdict }) => verdict.kind === "block")) {
    return { kind: "block", reason: texts.join("\n\n") };
  }

  return texts.length === 0 ? ALLOW : { kind: "note", text: texts.join("\n\n") };
}

function isEditHook(hook: HookKind): boolean {
  return hook === "pre-edit" || hook === "post-edit";
}

/** The verdict is the hook's answer: a state that cannot be written costs the next Stop its memory, not this one. */
function persist(state: SessionState, now: number): void {
  try {
    saveState(state, now);
  } catch (error) {
    console.error(
      `agent-hooks: state not saved: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function verdictOf(
  options: RunHookOptions,
  input: Input,
  root: string,
  state: SessionState,
  now: number,
): Promise<Verdict> {
  const { hook, handler } = options;
  const deadlineMs = options.deadlineMs ?? DEADLINES_MS[hook];
  // The fixers and lanes stop SETTLE_MS before the hook's own deadline, so a killed lane reports its timeout and the
  // run is recorded before `pastDeadline` would replace the whole verdict.
  const deadline = deadlineIn(Math.max(0, deadlineMs - SETTLE_MS), now);
  let config: Config;

  try {
    config = loadConfig(root);
  } catch (error) {
    const message = error instanceof ConfigError ? error.message : `agent-hooks: ${String(error)}`;

    return failureVerdict(
      hook,
      state,
      message,
      DEFAULT_CAP,
      hook === "session-start" ? ALLOW : { kind: "note", text: message },
    );
  }

  const context: HookContext = {
    hook,
    harness: options.harness,
    input,
    root,
    config,
    state,
    deadline,
    runner: options.runner ?? run,
  };

  try {
    return await Promise.race([
      handler(context),
      pastDeadline(hook, deadlineMs, deadlineIn(deadlineMs, now)),
    ]);
  } catch (error) {
    const message = `agent-hooks crashed: ${error instanceof Error ? error.message : String(error)}`;

    return failureVerdict(hook, state, message, config.stop.cap, ALLOW);
  }
}

/** A failure verdict at the deadline, so the harness never cuts a hook that has nothing to say. */
async function pastDeadline(
  hook: HookKind,
  deadlineMs: number,
  deadline: Deadline,
): Promise<never> {
  await Bun.sleep(deadline.remaining());

  throw new Error(`${hook} ran past its ${deadlineMs} ms deadline`);
}

/**
 * A Stop turns a kit failure into a block under the loop guard; an edit or a session start is never blocked and
 * gets `otherwise`: a note for an invalid config the user must fix, a plain allow for a crash.
 */
function failureVerdict(
  hook: HookKind,
  state: SessionState,
  message: string,
  cap: number,
  otherwise: Verdict,
): Verdict {
  if (hook === "stop") {
    return guard(state, { [CRASH_LANE]: [message] }, {}, cap, message);
  }

  console.error(message);

  return otherwise;
}

/** The wire shape of a verdict. Key order is part of the contract: the tests pin the bytes. */
export function encode(verdict: Verdict, harness: Harness, hook: HookKind): string | null {
  switch (verdict.kind) {
    case "allow": {
      return harness === "codex" && hook === "stop" ? JSON.stringify({ continue: true }) : null;
    }

    case "note": {
      return harness === "codex" && hook === "stop"
        ? JSON.stringify({ continue: true, systemMessage: verdict.text })
        : JSON.stringify({ systemMessage: verdict.text });
    }

    case "context": {
      const hookEventName = hook === "pre-edit" ? "PreToolUse" : "PostToolUse";

      return JSON.stringify({
        hookSpecificOutput: { hookEventName, additionalContext: verdict.text },
      });
    }

    case "block": {
      return JSON.stringify({ decision: "block", reason: verdict.reason });
    }

    case "rewrite": {
      if (harness !== "claude" || hook !== "pre-edit") {
        return null;
      }

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
