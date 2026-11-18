import type { PreBashContext } from "../core/runtime/hook.ts";
import type { PreBashAnswer, PreBashVerdict } from "../core/runtime/verdict.ts";
import type { Deadline } from "../core/util/exec.ts";
import type { GuardContext } from "../guard/judge-doors.ts";
import { humanOf, judgeLine, note, refusal } from "../guard/judge-doors.ts";
import { labelCommandRefusal } from "../guard/label-commands.ts";
import type { HumanMessage } from "../guard/refusals.ts";
import { worktreeLine } from "../guard/worktree.ts";

/**
 * The guards on a Bash tool call, in any repository. The landing guard refuses the one-way doors the repository's
 * `profile.landing` derives, or, without one, a push or a merge to the default branch of a public repository. A
 * command that runs passes the per-task line to the agent when it works in the main checkout of a per-task
 * repository another session is live in, a note of the others folded in: one answer carries one `additionalContext`.
 */
export async function runPreBash(context: PreBashContext): Promise<PreBashAnswer> {
  const verdict = await landingVerdict(context);

  if (verdict.kind === "deny") {
    return verdict;
  }

  const line = worktreeLine(context.command, context.cwd, context.sessionId, context.now);

  if (line === null) {
    return verdict;
  }

  return { kind: "context", text: verdict.kind === "note" ? `${line}\n${verdict.text}` : line };
}

/** The landing guard's verdict, raced against the deadline. */
async function landingVerdict(context: PreBashContext): Promise<PreBashVerdict> {
  const { input, command, cwd, deadline } = context;
  const typed = labelCommandRefusal(command, cwd);

  if (typed !== null) {
    return refusal(typed);
  }

  let human: HumanMessage | null = null;

  const guard: GuardContext = {
    sessionId: context.sessionId,
    cwd,
    now: context.now,
    deadline,
    human: () => {
      human ??= humanOf(input);

      return human;
    },
  };

  return (
    (await Promise.race([judgeLine(command, cwd, guard, 0), pastDeadline(deadline)])) ??
    note(
      `agent-hooks: pre-bash ran past its ${context.deadlineMs} ms deadline: the command went unchecked`,
    )
  );
}

async function pastDeadline(deadline: Deadline): Promise<null> {
  await Bun.sleep(deadline.remaining());

  return null;
}
