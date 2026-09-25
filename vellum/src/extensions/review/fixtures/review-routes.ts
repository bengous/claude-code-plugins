import type { AgentInfo, AgentSpawnArgs, AgentSpawnResult, On } from "claude-code";

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

/**
 * The review routes a server answers, and every body the module posted there, by route name:
 * 204 unless `answers` names the route. The run it serves moves as the server's own would: a
 * `launched` runs it, an `ended` or a `close` drops it, so a second `stage` line reads what the
 * first one's post made of it.
 */
export function reviewRoutes(
  run: Run | null,
  answers: Readonly<Record<string, Route>> = {},
): ReviewRoutes {
  const posted: [name: string, body: string][] = [];

  const moved = (name: string, now: Run | null): Run | null => {
    if (name === "launched" && now?.kind === "requested") {
      return { ...now, kind: "running", agentId: AGENT_ID, model: MODEL };
    }

    return name === "ended" || name === "close" ? null : now;
  };

  const post =
    (name: string): Route =>
    (body, query) => {
      posted.push([name, body ?? ""]);
      const answer = answers[name];

      if (answer !== undefined) return answer(body, query);
      served.state = { ...served.state, run: moved(name, served.state.run) };

      return reply(204, null);
    };

  const served: ReviewRoutes = {
    posted,
    state: { run, failed: null },
    routes: {
      "/api/x/review/state": () => reply(200, served.state),
      ...Object.fromEntries(
        ["launched", "ended", "close"].map((name) => [`/api/x/review/${name}`, post(name)]),
      ),
    },
  };

  return served;
}

export type Agents = {
  /** Every spawn the module asked for, its prompt and its description. */
  readonly spawned: Pick<AgentSpawnArgs, "prompt" | "description">[];
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
    seen.spawned.push({ prompt: e.prompt, description: e.description });

    return answer();
  });

  on("agent.list", () => ({ value: seen.listed }));

  return seen;
}
