import type { AgentInfo, AgentSpawnArgs, AgentSpawnResult, On, ToolCallResult } from "claude-code";

import type { Route } from "../../../core/engine/fixtures/index.ts";
import { reply } from "../../../core/engine/fixtures/index.ts";
import type { ReviewState, Run } from "../protocol.ts";

export const MODEL = "claude-opus-5-5";

export const AGENT_ID = "a1";

export const REQUESTED: Run = { kind: "requested", seq: 1, version: 3 };

export const RUNNING: Run = { ...REQUESTED, kind: "running", agentId: AGENT_ID, model: MODEL };

export type ReviewRoutes = {
  readonly routes: Record<string, Route>;
  readonly posted: [name: string, body: string][];
  /** What `GET state` answers now: a test sets it as the server's run moves. */
  state: ReviewState;
};

/** What a post makes of the state, as the server's route would: a number that is not the run's changes nothing. */
function moved(name: string, body: string | undefined, now: ReviewState): ReviewState {
  const { run, stopping } = now;
  // SAFETY: the module's own `ReviewPosts[name]`, serialized by `JSON.stringify` in review/engine.ts.
  const { seq } = JSON.parse(body ?? "{}") as { readonly seq?: number };

  switch (name) {
    case "launched":
      return run?.kind === "requested" && run.seq === seq
        ? { ...now, run: { ...run, kind: "running", agentId: AGENT_ID, model: MODEL } }
        : now;
    case "ended":
      return run?.seq === seq ? { ...now, run: null, resubmit: true } : now;
    case "close": {
      const agent = run?.kind === "running" ? [{ seq: run.seq, agentId: run.agentId }] : [];

      return { ...now, run: null, stopping: [...stopping, ...agent] };
    }

    case "stopped":
      return { ...now, stopping: stopping.filter((one) => one.seq !== seq) };

    case "resubmitted":
      return { ...now, resubmit: false };
    default:
      return now;
  }
}

/**
 * The review routes a server answers, and every body the module posted there, by route name:
 * 204 unless `answers` names the route, and `close` its `Closed`. The state it serves moves as the
 * server's own would, so a second `stage` line reads what the first one's post made of it.
 */
export function reviewRoutes(
  run: Run | null,
  answers: Readonly<Record<string, Route>> = {},
): ReviewRoutes {
  const posted: [name: string, body: string][] = [];

  const post =
    (name: string): Route =>
    (body, query) => {
      posted.push([name, body ?? ""]);
      const answer = answers[name];

      if (answer !== undefined) return answer(body, query);
      served.state = moved(name, body, served.state);

      return name === "close" ? reply(200, { stopping: served.state.stopping }) : reply(204, null);
    };

  const served: ReviewRoutes = {
    posted,
    state: { run, failed: null, stopping: [], resubmit: false },
    routes: {
      "/api/x/review/state": () => reply(200, served.state),
      ...Object.fromEntries(
        ["launched", "ended", "close", "stopped", "resubmitted"].map((name) => [
          `/api/x/review/${name}`,
          post(name),
        ]),
      ),
    },
  };

  return served;
}

export type Agents = {
  /** Every spawn the module asked for, its prompt, its description and its directory. */
  readonly spawned: Pick<AgentSpawnArgs, "prompt" | "description" | "cwd">[];
  /** What `$.agent.list()` answers now. */
  listed: AgentInfo[];
};

/**
 * The engine's subagents beneath the module. The kit starts none: nothing answers beneath
 * `agent.spawn`, and a hook that answers without `next` started none, so its `agentId` never
 * reaches the caller. `answer` is that hook's; the list answers what the test set.
 */
export function agents(on: On, answer: () => AgentSpawnResult = () => ({ model: MODEL })): Agents {
  const seen: Agents = { spawned: [], listed: [] };

  on("agent.spawn", (_, e) => {
    const spawn: Agents["spawned"][number] = { prompt: e.prompt, description: e.description };

    if (e.cwd !== undefined) spawn.cwd = e.cwd;
    seen.spawned.push(spawn);

    return answer();
  });

  on("agent.list", () => ({ value: seen.listed }));

  return seen;
}

/** The result `TaskStop` gives an agent it stopped, as measured in a live session. */
export function stoppedResult(agentId: string): ToolCallResult {
  return {
    result: { message: `Successfully stopped task: ${agentId}`, task_id: agentId },
    text: `{"message":"Successfully stopped task: ${agentId}"}`,
  };
}

/**
 * `TaskStop` beneath the module's `$.tool.call`: every task id it was asked to stop, in order, and
 * what it answers, a success unless `answer` says otherwise.
 */
export function stops(
  on: On,
  answer: (agentId: string) => ToolCallResult | Promise<ToolCallResult> = stoppedResult,
): string[] {
  const asked: string[] = [];

  on("tool.call", { tool: "TaskStop" }, (_, e) => {
    const agentId = e.task_id ?? "";
    asked.push(agentId);

    return answer(agentId);
  });

  return asked;
}
