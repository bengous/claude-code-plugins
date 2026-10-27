import type { Deadline, Runner } from "./exec.ts";
import { deadlineIn, run } from "./exec.ts";
import type { GuardContext, GuardVerdict } from "./guard/judge-doors.ts";
import { combine, humanOf, judgeLine, note } from "./guard/judge-doors.ts";
import type { HumanMessage } from "./guard/refusals.ts";
import type { Input } from "./hook.ts";
import { heartbeat, parseInput } from "./hook.ts";
import { isRecord, recordField, stringField } from "./json.ts";
import type { Settle } from "./judge/judge-commits.ts";
import { judgeCommits } from "./judge/judge-commits.ts";

/** Below the 30 s timeout `hooks/hooks.json` gives pre-bash, so the hook answers before Claude Code cuts it. */
export const PRE_BASH_DEADLINE_MS = 25_000;

export type PreBashOptions = {
  readonly now?: number;
  /** Overrides PRE_BASH_DEADLINE_MS for the tests. */
  readonly deadlineMs?: number;
  /** Runs the commit judge; the tests pass a fake. */
  readonly runner?: Runner;
};

/** The PreToolUse wire shape of a verdict, null for an allow. */
export function encodeGuard(verdict: GuardVerdict): string | null {
  switch (verdict.kind) {
    case "allow": {
      return null;
    }

    case "note": {
      return JSON.stringify({ systemMessage: verdict.text });
    }

    case "deny": {
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: verdict.reason,
        },
      });
    }

    default: {
      const unreachable: never = verdict;
      throw new Error(`unhandled verdict: ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * The landing guard on a Bash tool call, in any repository: refuses the one-way doors the repository's
 * `profile.landing` derives, or, without one, a push or a merge to the default branch of a public repository.
 * Returns the line to print, or null. Never throws: a crash lets the command through with a note.
 */
export async function runPreBash(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the hook payload arrives as parsed JSON from stdin; this function is where it is narrowed.
  payload: unknown,
  options: PreBashOptions = {},
): Promise<string | null> {
  const now = options.now ?? Date.now();
  const deadlineMs = options.deadlineMs ?? PRE_BASH_DEADLINE_MS;
  const deadline = deadlineIn(deadlineMs, now);

  try {
    const input = isRecord(payload) ? parseInput(payload) : null;

    if (input !== null) {
      heartbeat(input);
    }

    const toolInput = isRecord(payload) ? recordField(payload, "tool_input") : undefined;
    const command = toolInput === undefined ? undefined : stringField(toolInput, "command");

    if (!isRecord(payload) || command === undefined) {
      return null;
    }

    let human: HumanMessage | null = null;

    const context: GuardContext = {
      sessionId: stringField(payload, "session_id") ?? "",
      cwd: stringField(payload, "cwd") ?? process.cwd(),
      now,
      deadline,
      human: () => {
        human ??= humanOf(input);

        return human;
      },
    };

    const cwd = stringField(payload, "cwd") ?? process.cwd();

    const judging =
      input === null ? null : judgeCommitsOf(command, cwd, input, deadline, options.runner ?? run);

    const verdict =
      (await Promise.race([judgeLine(command, cwd, context, 0), pastDeadline(deadline)])) ??
      note(
        `agent-hooks: pre-bash ran past its ${deadlineMs} ms deadline: the command went unchecked`,
      );

    if (verdict.kind === "deny" || judging === null) {
      return encodeGuard(verdict);
    }

    const judged = (await judging)();

    return encodeGuard(
      judged.kind === "deny" && verdict.kind === "note"
        ? { kind: "deny", reason: `${judged.reason}\n${verdict.text}` }
        : combine([verdict, judged]),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return encodeGuard(
      note(`agent-hooks: pre-bash crashed (${message}): the command went unchecked`),
    );
  }
}

/**
 * `judgeCommits`, started beside the landing guard so Haiku's wait overlaps the guard's lookups. Its crash lets the
 * commits through with a note and never costs the guard's verdict.
 */
async function judgeCommitsOf(
  command: string,
  cwd: string,
  input: Input,
  deadline: Deadline,
  runner: Runner,
): Promise<Settle> {
  try {
    const settle = await judgeCommits(command, cwd, input, deadline, runner);

    return () => {
      try {
        return settle();
      } catch (error) {
        return judgeCrashed(error instanceof Error ? error.message : String(error));
      }
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return () => judgeCrashed(message);
  }
}

function judgeCrashed(message: string): GuardVerdict {
  return note(`agent-hooks: the commit judge crashed (${message}): the commit passed`);
}

async function pastDeadline(deadline: Deadline): Promise<null> {
  await Bun.sleep(deadline.remaining());

  return null;
}
