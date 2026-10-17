/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-returns -- this module is the hook payload's boundary: the harness's JSON arrives on stdin, `parseInput` turns it into `Input`, and only `tool_input`, the harness's per-tool shape, travels on as a record to be handed back as `updatedInput`. */
import { existsSync } from "node:fs";
import path from "node:path";

import type { BackgroundTaskSummary } from "@anthropic-ai/claude-agent-sdk";

import type { Config } from "./config.ts";
import { ConfigError, DEFAULT_CAP, loadConfig } from "./config.ts";
import type { Deadline, Runner } from "./exec.ts";
import { OUTPUT_GRACE_MS, deadlineIn, run } from "./exec.ts";
import { isRecord, recordField, stringField } from "./json.ts";
import { CRASH_LANE, guard } from "./loop-guard.ts";
import { extractApplyPatchPaths } from "./patch.ts";
import { checkoutOf, findRoot, realPathOf } from "./scope.ts";
import type { SessionState } from "./state.ts";
import { AGENT_SEPARATOR, beat, freshState, loadState, saveState, statesOf } from "./state.ts";

export const HARNESSES = ["claude", "codex"] as const;

export type Harness = (typeof HARNESSES)[number];

export const HOOK_KINDS = ["session-start", "pre-edit", "post-edit", "stop"] as const;

export type HookKind = (typeof HOOK_KINDS)[number];

/** The hooks that run at one root, the one around their file or cwd; the Stop runs over every checkout instead. */
export type RootHookKind = Exclude<HookKind, "stop">;

export const DEADLINES_MS: Readonly<Record<HookKind, number>> = {
  "session-start": 4000,
  "pre-edit": 25_000,
  "post-edit": 50_000,
  stop: 200_000,
};

/** The event name a hook's `hookSpecificOutput` carries, under Claude Code and Codex alike. */
const HOOK_EVENTS: Readonly<Record<HookKind, string>> = {
  "session-start": "SessionStart",
  "pre-edit": "PreToolUse",
  "post-edit": "PostToolUse",
  stop: "Stop",
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
};

/** What a root hook runs with: its root's config and the agent's state in the checkout around its file or cwd. */
export type HookContext = {
  readonly hook: RootHookKind;
  readonly harness: Harness;
  readonly input: Input;
  readonly root: string;
  readonly config: Config;
  readonly state: SessionState;
  readonly deadline: Deadline;
  readonly runner: Runner;
};

/** What a Stop runs with: the agent's state in each checkout it measures. */
export type StopContext = {
  readonly harness: Harness;
  readonly input: Input;
  /**
   * Each checkout the agent photographed, and for the main session the one around its cwd, photographed or not.
   * A checkout without a photo is measured over its whole dirty tree.
   */
  readonly checkouts: readonly SessionState[];
  readonly deadline: Deadline;
  readonly runner: Runner;
};

export type Handler = (context: HookContext) => Promise<Verdict>;

export type StopHandler = (context: StopContext) => Promise<Verdict>;

/** A hook with its handler: the Stop's reads every checkout, a root hook's reads one root. */
export type HookRun =
  | { readonly hook: "stop"; readonly handler: StopHandler }
  | { readonly hook: RootHookKind; readonly handler: Handler };

export type RunHookOptions = HookRun & {
  readonly harness: Harness;
  readonly payload: unknown;
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
 * Where the root searches start, symlinks resolved: the edited file's directory for the edit hooks, each patched
 * file's for a Codex `apply_patch`, the payload's cwd otherwise.
 */
export function searchStarts(hook: HookKind, input: Input): string[] {
  const edited = hook === "pre-edit" || hook === "post-edit" ? editedPaths(input) : [];

  if (edited.length === 0) {
    return input.cwd === undefined ? [] : [input.cwd];
  }

  return [
    ...new Set(
      edited.map((file) =>
        realPathOf(path.dirname(path.resolve(input.cwd ?? process.cwd(), file))),
      ),
    ),
  ];
}

function editedPaths(input: Input): string[] {
  const filePath = stringField(input.toolInput, "file_path");
  const command = stringField(input.toolInput, "command");

  return [
    ...(filePath === undefined ? [] : [filePath]),
    ...(command === undefined ? [] : extractApplyPatchPaths(command)),
  ];
}

/**
 * The envelope every hook runs in: reads the payload, finds what the hook measures, runs the handler under a
 * deadline, saves the state and encodes the verdict for the harness. Returns the line to print, or null for no
 * output. Never throws: a crash is a verdict too.
 */
export async function runHook(options: RunHookOptions): Promise<string | null> {
  const { harness, payload } = options;

  if (!isRecord(payload)) {
    console.error("agent-hooks: empty or invalid payload on stdin");

    return null;
  }

  const input = parseInput(payload);

  if (input === null) {
    console.error("agent-hooks: payload has no session_id");

    return null;
  }

  const now = options.now ?? Date.now();
  heartbeat(input);

  const verdict =
    options.hook === "stop"
      ? await runStopHook(options, input, now)
      : await runRootHook(options, input, now);

  return verdict === null ? null : encode(verdict, harness, options.hook);
}

/**
 * The name of the state a hook reads and writes: the session's, or for a subagent its own under the session, so two
 * subagents of one session keep their own photo, failing set and block counter.
 */
export function stateKey(input: Input): string {
  return input.agentId === undefined
    ? input.sessionId
    : `${input.sessionId}${AGENT_SEPARATOR}${input.agentId}`;
}

/**
 * Marks the agent live in the checkout around its cwd, when a root encloses it: every kit hook beats, so a session
 * that stops calling them there ages out. A beat that cannot be placed or written is reported and costs nothing else.
 */
export function heartbeat(input: Input): void {
  try {
    const checkout = cwdCheckout(input);

    if (checkout !== null) {
      beat(stateKey(input), checkout);
    }
  } catch (error) {
    console.error(
      `agent-hooks: heartbeat not saved: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

type StopRun = RunHookOptions & { readonly hook: "stop" };

type RootRun = RunHookOptions & { readonly hook: RootHookKind };

/** A Stop: every checkout's state read once, the handler over all of them, every state saved. */
async function runStopHook(options: StopRun, input: Input, now: number): Promise<Verdict | null> {
  const checkouts = stopStates(input, now);

  if (checkouts.length === 0) {
    return null;
  }

  const deadlineMs = options.deadlineMs ?? DEADLINES_MS.stop;
  let verdict: Verdict;

  try {
    verdict = await raced("stop", deadlineMs, now, (deadline) =>
      options.handler({
        harness: options.harness,
        input,
        checkouts,
        deadline,
        runner: options.runner ?? run,
      }),
    );
  } catch (error) {
    // A kit failure blocks under the brake of the checkout around the cwd, so a crash never ends the turn silently.
    const message = `agent-hooks crashed: ${error instanceof Error ? error.message : String(error)}`;
    const braked = checkouts.find((state) => state.checkout === cwdCheckout(input)) ?? checkouts[0];

    verdict =
      braked === undefined
        ? ALLOW
        : guard(braked, { [CRASH_LANE]: [message] }, {}, DEFAULT_CAP, message);
  }

  for (const state of checkouts) {
    persist(state, now);
  }

  return verdict;
}

/**
 * The checkouts a Stop measures: each one the agent photographed, wherever its cwd has moved since, and for the main
 * session the checkout around its cwd when no photo covers it, measured over its whole dirty tree: Bash and a Codex
 * patch photograph nothing, and checking too much beats missing a change. A state without a photo belongs to a
 * former cwd and is left alone once the cwd moved away: the whole tree there is other sessions' work. A subagent
 * keeps to what it photographed: over a shared checkout's whole tree, one that edited nothing would block on its
 * parent's work. A checkout gone from disk is left out.
 */
function stopStates(input: Input, now: number): SessionState[] {
  const key = stateKey(input);
  const checkout = input.agentId === undefined ? cwdCheckout(input) : null;

  const measured = statesOf(key).filter(
    (state) => existsSync(state.checkout) && (state.photo !== null || state.checkout === checkout),
  );

  if (checkout === null || measured.some((state) => state.checkout === checkout)) {
    return measured;
  }

  return [...measured, freshState(key, checkout, now)].toSorted((left, right) =>
    left.checkout < right.checkout ? -1 : Number(left.checkout > right.checkout),
  );
}

/** The checkout around the payload's cwd, when that cwd lies under a root; a root outside git is its own checkout. */
function cwdCheckout(input: Input): string | null {
  const root = input.cwd === undefined ? null : findRoot(input.cwd);

  return root === null ? null : (checkoutOf(input.cwd ?? root) ?? root);
}

/**
 * A root hook: the root around its file or cwd, with the agent's state in the checkout there; a Codex patch spanning
 * several roots runs once per root, the states shared per checkout. A state is saved when it photographed.
 */
async function runRootHook(options: RootRun, input: Input, now: number): Promise<Verdict | null> {
  const pairs = rootPairs(options.hook, input);

  if (pairs.length === 0) {
    return null;
  }

  const states = new Map<string, SessionState>();
  const hadPhoto = new Map<string, boolean>();

  for (const { checkout } of pairs) {
    if (!states.has(checkout)) {
      const state = loadState(stateKey(input), checkout, now);
      states.set(checkout, state);
      hadPhoto.set(checkout, state.photo !== null);
    }
  }

  const verdicts = await Promise.all(
    pairs.map(({ root, checkout }) => {
      const state = states.get(checkout);

      if (state === undefined) {
        throw new Error(`no state loaded for ${checkout}`);
      }

      return rootVerdict(options, input, root, state, now);
    }),
  );

  // An edit hook changes a state only when it photographs a checkout that had no photo: that alone decides its
  // save. A session start always saves, which refreshes the state's age.
  for (const [checkout, state] of states) {
    if (
      options.hook === "session-start" ||
      (hadPhoto.get(checkout) === false && state.photo !== null)
    ) {
      persist(state, now);
    }
  }

  return mergedRootVerdicts(verdicts);
}

type RootPair = { readonly root: string; readonly checkout: string };

/** Each root a root hook runs at, with the checkout around its start; a root outside git is its own checkout. */
function rootPairs(hook: RootHookKind, input: Input): RootPair[] {
  const pairs = new Map<string, RootPair>();

  for (const start of searchStarts(hook, input)) {
    const root = findRoot(start);

    if (root !== null) {
      const checkout = checkoutOf(start) ?? root;
      pairs.set(`${root}\u0000${checkout}`, { root, checkout });
    }
  }

  return [...pairs.values()];
}

/**
 * One verdict for a root hook: the only root's as it is; over several roots, their contexts and notes as one
 * `additionalContext`, since a Codex patch is the one hook that reaches several roots and it never rewrites.
 */
function mergedRootVerdicts(verdicts: readonly Verdict[]): Verdict {
  const [only] = verdicts;

  if (only !== undefined && verdicts.length === 1) {
    return only;
  }

  const texts = verdicts.flatMap((verdict) =>
    verdict.kind === "context" || verdict.kind === "note" ? [verdict.text] : [],
  );

  return texts.length === 0 ? ALLOW : { kind: "context", text: texts.join("\n\n") };
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

/**
 * A root hook never blocks: an invalid config is a note the user must act on; a crash is reported on stderr and lets
 * the tool run as asked.
 */
async function rootVerdict(
  options: RootRun,
  input: Input,
  root: string,
  state: SessionState,
  now: number,
): Promise<Verdict> {
  const { hook, handler } = options;
  const deadlineMs = options.deadlineMs ?? DEADLINES_MS[hook];
  let config: Config;

  try {
    config = loadConfig(root);
  } catch (error) {
    const message = error instanceof ConfigError ? error.message : `agent-hooks: ${String(error)}`;
    console.error(message);

    return { kind: "note", text: message };
  }

  try {
    return await raced(hook, deadlineMs, now, (deadline) =>
      handler({
        hook,
        harness: options.harness,
        input,
        root,
        config,
        state,
        deadline,
        runner: options.runner ?? run,
      }),
    );
  } catch (error) {
    console.error(`agent-hooks crashed: ${error instanceof Error ? error.message : String(error)}`);

    return ALLOW;
  }
}

/**
 * Runs the handler against the hook's deadline. The fixers and lanes stop SETTLE_MS before it, so a killed lane
 * reports its timeout and the run is recorded before `pastDeadline` would replace the whole verdict.
 */
function raced(
  hook: HookKind,
  deadlineMs: number,
  now: number,
  handler: (deadline: Deadline) => Promise<Verdict>,
): Promise<Verdict> {
  return Promise.race([
    handler(deadlineIn(Math.max(0, deadlineMs - SETTLE_MS), now)),
    pastDeadline(hook, deadlineMs, deadlineIn(deadlineMs, now)),
  ]);
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
      return JSON.stringify({
        hookSpecificOutput: { hookEventName: HOOK_EVENTS[hook], additionalContext: verdict.text },
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
