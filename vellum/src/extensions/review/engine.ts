import type { AgentSpawnResult } from "claude-code";

import type { EngineContext, EngineExtension } from "../../core/engine/extension.ts";
import type { Live } from "../../core/engine/mode.ts";
import { parseJson, parseReviewState } from "./parse.ts";
import type { Outcome, ReviewPosts, ReviewState, Run } from "./protocol.ts";
import { REVIEWER } from "./protocol.ts";

/** What the person at the terminal must know: a review runs, and its file lands in the rail. */
const SEGMENT_RUNNING = "review · running";

/** The modes whose last read found a run under way, keyed by the mode's own `Live`: a new way in starts with none. */
const underWay = new WeakSet<Live>();

function post<Name extends keyof ReviewPosts>(
  context: EngineContext,
  name: Name,
  body: ReviewPosts[Name],
): ReturnType<EngineContext["api"]["post"]> {
  return context.api.post(name, JSON.stringify(body));
}

async function stateOf({ api }: EngineContext): Promise<ReviewState | null> {
  return parseReviewState(parseJson((await api.get("state")).text));
}

async function ended(context: EngineContext, seq: number, outcome: Outcome): Promise<void> {
  await post(context, "ended", { seq, outcome });
}

/** The agent reads the version's file, whose lines are the ones it names; vellum does not know the request. */
function promptOf(workdir: string, version: number): string {
  return `Review the plan at ${workdir}.review/v${version}.md, version ${version} of ${workdir}plan.md; its artifacts are the files of ${workdir} it names. No request is given: judge intent against the plan's title and Decisions. Give line numbers of that file.`;
}

/** Spawns the reviewer for a run the page asked for; a refusal or a failure ends the run, with why. */
async function launch(context: EngineContext, run: Run): Promise<void> {
  const spawned: AgentSpawnResult | { readonly deny: string } = await context.host
    .spawnAgent({
      subagentType: REVIEWER,
      description: `plan review v${run.version}`,
      prompt: promptOf(context.live.session.workdir, run.version),
    })
    .catch((cause: unknown) => ({ deny: `the launch failed: ${String(cause)}` }));

  if (spawned.deny !== undefined) {
    await ended(context, run.seq, { kind: "failed", why: spawned.deny });

    return;
  }

  if (spawned.agentId === undefined) {
    await ended(context, run.seq, { kind: "failed", why: "the engine started no agent" });

    return;
  }

  await post(context, "launched", { seq: run.seq, agentId: spawned.agentId, model: spawned.model });
}

/**
 * An agent the engine no longer runs, killed or lost, ends its run as failed. It is read at a
 * `stage` line, the one moment this half runs without the agent: its end, when it comes, is its
 * own `turn.complete`.
 */
async function check(
  context: EngineContext,
  run: Run & { readonly kind: "running" },
): Promise<void> {
  const agent = (await context.host.listAgents()).find(({ id }) => id === run.agentId);

  if (agent?.status === "running") return;
  await ended(context, run.seq, { kind: "failed", why: agent?.status ?? "the agent is gone" });
}

/** The run under way, read again each time the review changed: launched when asked, checked while running. */
async function staged(context: EngineContext): Promise<void> {
  const state = await stateOf(context);

  if (state === null) return;
  const { run } = state;

  if (run === null) underWay.delete(context.live);
  else underWay.add(context.live);

  if (run?.kind === "requested") await launch(context, run);
  else if (run?.kind === "running") await check(context, run);
}

export const reviewEngine: EngineExtension = {
  id: "review",
  staged,
  // Read from the server, never from memory: an answer that lands after a reload still finds its run.
  agentAnswered: async (context, turn) => {
    const run = (await stateOf(context))?.run;

    if (run?.kind !== "running" || run.agentId !== turn.agentId) return;

    if (turn.reason !== "answer") {
      await ended(context, run.seq, { kind: "failed", why: turn.reason });

      return;
    }

    const outcome: Outcome =
      turn.text.trim() === ""
        ? { kind: "failed", why: "no answer" }
        : { kind: "answer", text: turn.text };

    await ended(context, run.seq, outcome);
  },
  segment: ({ live }) => (underWay.has(live) ? SEGMENT_RUNNING : null),
  closing: async (context) => {
    await post(context, "close", {});
  },
};
