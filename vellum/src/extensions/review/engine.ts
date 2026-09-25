import type { AgentSpawnResult } from "claude-code";

import type { EngineContext, EngineExtension } from "../../core/engine/extension.ts";
import type { Live } from "../../core/engine/mode.ts";
import { parseClosed, parseJson, parseReviewState } from "./parse.ts";
import type { Outcome, ReviewPosts, ReviewState, Run, Stopping } from "./protocol.ts";
import { REVIEWER } from "./protocol.ts";

/** What the person at the terminal must know: a review runs, and its file lands in the rail. */
const SEGMENT_RUNNING = "review · running";

/**
 * How long a run whose agent the engine no longer runs keeps the review before it fails: an
 * agent's end reaches the module 14 to 40 ms after it leaves `$.agent.list()` (measured in #232).
 */
export const GRACE_MS = 10_000;

/** How long a stop may take before it counts as not confirmed; several run at once, in a hook's budget. */
export const STOP_MS = 3000;

/** When an answer the server did not take is posted again: a revived server answers on the same port. */
export const RETRY_MS = 1000;

/** Why a run fails once its grace ran out. */
export const LOST = "its verdict never reached vellum";

/** The modes whose last read found a run under way, keyed by the mode's own `Live`: a new way in starts with none. */
const underWay = new WeakSet<Live>();

/** The runs of a mode whose grace runs now, by number: one timer per run and mode, armed again after a reload. */
const graced = new WeakMap<Live, Set<number>>();

/** The runs of a mode whose agent a stop left running, already logged: once each, not at every read. */
const unstopped = new WeakMap<Live, Set<number>>();

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

/** Resolves after `ms` on the engine's clock, or with `work` if it settles first; the timer goes either way. */
function within<T>(context: EngineContext, ms: number, work: Promise<T>, late: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = context.host.after(ms, () => {
      resolve(late);
    });

    void work.then((value) => {
      timer.cancel();
      resolve(value);
    });
  });
}

/**
 * Stops the agent with `TaskStop`: `null` once confirmed, by a result that is no error or by an
 * agent the engine no longer runs; else why not. A stopped agent's own end is `aborted`.
 */
async function stop(context: EngineContext, agentId: string): Promise<string | null> {
  const called = context.host.callTool({ tool: "TaskStop", task_id: agentId }).then(
    (answer) => {
      if (answer.deny !== undefined) return `TaskStop was denied: ${answer.deny}`;

      return answer.isError === true ? `TaskStop answered: ${answer.text}` : null;
    },
    (cause: unknown) => `TaskStop failed: ${String(cause)}`,
  );

  const why = await within(context, STOP_MS, called, `TaskStop did not answer in ${STOP_MS} ms`);

  if (why === null) return null;
  const listed = await context.host.listAgents().catch(() => null);
  const running = listed?.some(({ id, status }) => id === agentId && status === "running") ?? true;

  return running ? why : null;
}

/** Every agent listed to stop, at once: a stop confirmed leaves the list, one that is not is logged once. */
async function stopEach(context: EngineContext, stopping: readonly Stopping[]): Promise<void> {
  await Promise.all(
    stopping.map(async ({ seq, agentId }) => {
      const why = await stop(context, agentId);

      if (why === null) {
        await post(context, "stopped", { seq });

        return;
      }

      const logged = unstopped.get(context.live) ?? new Set<number>();

      if (!logged.has(seq)) {
        context.host.log(`the plan reviewer of review ${seq} is not stopped: ${why}`);
      }

      unstopped.set(context.live, logged.add(seq));
    }),
  );
}

/** The agent reads the version's file, whose lines are the ones it names; vellum does not know the request. */
function promptOf(workdir: string, version: number): string {
  return `Review the plan at ${workdir}.review/v${version}.md, version ${version} of ${workdir}plan.md; its artifacts are the files of ${workdir} it names. No request is given: judge intent against the plan's title and Decisions. Give line numbers of that file.`;
}

/**
 * Spawns the reviewer for a run the page asked for; a refusal or a failure ends the run, with why.
 * A launch the server no longer takes, the run given up meanwhile, stops the agent it started.
 */
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

  const { agentId, model } = spawned;

  if (agentId === undefined) {
    await ended(context, run.seq, { kind: "failed", why: "the engine started no agent" });

    return;
  }

  const launched = await post(context, "launched", { seq: run.seq, agentId, model }).catch(
    () => null,
  );

  if (launched?.status === 204) return;
  const why = await stop(context, agentId);

  if (why !== null) context.host.log(`the plan reviewer of a run given up is not stopped: ${why}`);
}

/**
 * A run whose agent was killed or failed ends at once. One the engine no longer runs otherwise,
 * gone or completed, may still be handing its answer over: it keeps the review `GRACE_MS`, then
 * fails if it still does. A `stage` line starts the grace, and every start of a server writes one,
 * so a reload or a `claude --resume` arms it again.
 */
async function check(
  context: EngineContext,
  run: Run & { readonly kind: "running" },
): Promise<void> {
  const agent = (await context.host.listAgents()).find(({ id }) => id === run.agentId);
  const status = agent?.status;

  if (status === "running") return;

  if (status === "killed" || status === "failed") {
    await ended(context, run.seq, { kind: "failed", why: status });

    return;
  }

  const armed = graced.get(context.live) ?? new Set<number>();

  if (armed.has(run.seq)) return;
  graced.set(context.live, armed.add(run.seq));

  context.host.after(GRACE_MS, () => {
    armed.delete(run.seq);

    void (async () => {
      const now = (await stateOf(context))?.run;

      if (now?.kind === "running" && now.seq === run.seq) {
        await ended(context, run.seq, { kind: "failed", why: LOST });
      }
    })().catch((cause: unknown) => {
      context.host.log(`the plan review ${run.seq} was not ended: ${String(cause)}`);
    });
  });
}

/**
 * The review, read again each time it changed: the agents to stop first, then the run, launched
 * when asked and checked while running, then a version Claude wrote while a run held the review.
 */
async function staged(context: EngineContext): Promise<void> {
  const state = await stateOf(context);

  if (state === null) return;
  const { run, stopping, resubmit } = state;

  if (run === null) underWay.delete(context.live);
  else underWay.add(context.live);

  await stopEach(context, stopping);

  if (run?.kind === "requested") await launch(context, run);
  else if (run?.kind === "running") await check(context, run);

  if (resubmit && run === null && (await context.submitIdle())) {
    await post(context, "resubmitted", {});
  }
}

/** Read from the server, never from memory: an answer that lands after a reload still finds its run. */
async function answered(
  context: EngineContext,
  agentId: string,
  reason: string,
  text: string,
): Promise<void> {
  const run = (await stateOf(context))?.run;

  if (run?.kind !== "running" || run.agentId !== agentId) return;

  if (reason !== "answer") {
    await ended(context, run.seq, { kind: "failed", why: reason });

    return;
  }

  const outcome: Outcome =
    text.trim() === "" ? { kind: "failed", why: "no answer" } : { kind: "answer", text };

  await ended(context, run.seq, outcome);
}

export const reviewEngine: EngineExtension = {
  id: "review",
  staged,
  // A server that does not answer is asked once more: past that, the grace ends the run.
  agentAnswered: async (context, { agentId, reason, text }) => {
    await answered(context, agentId, reason, text).catch(async () => {
      await new Promise<void>((resolve) => {
        context.host.after(RETRY_MS, resolve);
      });
      await answered(context, agentId, reason, text);
    });
  },
  segment: ({ live }) => (underWay.has(live) ? SEGMENT_RUNNING : null),
  // `close` first: the stopped agent's `aborted` end then finds no run, and fails none.
  closing: async (context) => {
    const response = await post(context, "close", {});
    const closed = parseClosed(parseJson(response.text));

    if (closed === null) {
      context.host.log(`the review server did not close the plan review: ${response.status}`);

      return;
    }

    await stopEach(context, closed.stopping);
  },
};
