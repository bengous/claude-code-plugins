import { messageOf } from "./errors.ts";
import type { Deadline, Runner } from "./exec.ts";
import type { GuardContext } from "./guard/judge-doors.ts";
import { combine, humanOf, judgeLine, note } from "./guard/judge-doors.ts";
import type { HumanMessage } from "./guard/refusals.ts";
import type { PreBashContext } from "./hook.ts";
import type { Settle } from "./judge/judge-commits.ts";
import { judgeCommits } from "./judge/judge-commits.ts";
import type { Input } from "./payload.ts";
import type { PreBashVerdict } from "./verdict.ts";

/**
 * The landing guard on a Bash tool call, in any repository: refuses the one-way doors the repository's
 * `profile.landing` derives, or, without one, a push or a merge to the default branch of a public repository. The
 * guard alone races the deadline, so a guard past it still joins the commit judge's answer.
 */
export async function runPreBash(context: PreBashContext): Promise<PreBashVerdict> {
  const { input, command, cwd, deadline } = context;
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

  const judging =
    input === null ? null : judgeCommitsOf(command, cwd, input, deadline, context.runner);

  const verdict =
    (await Promise.race([judgeLine(command, cwd, guard, 0), pastDeadline(deadline)])) ??
    note(
      `agent-hooks: pre-bash ran past its ${context.deadlineMs} ms deadline: the command went unchecked`,
    );

  if (verdict.kind === "deny" || judging === null) {
    return verdict;
  }

  const judged = (await judging)();

  return judged.kind === "deny" && verdict.kind === "note"
    ? { kind: "deny", reason: `${judged.reason}\n${verdict.text}` }
    : combine([verdict, judged]);
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
        return judgeCrashed(messageOf(error));
      }
    };
  } catch (error) {
    const message = messageOf(error);

    return () => judgeCrashed(message);
  }
}

function judgeCrashed(message: string): PreBashVerdict {
  return note(`agent-hooks: the commit judge crashed (${message}): the commit passed`);
}

async function pastDeadline(deadline: Deadline): Promise<null> {
  await Bun.sleep(deadline.remaining());

  return null;
}
