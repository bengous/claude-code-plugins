import type {
  Reply,
  ServerContext,
  ServerHalf,
  SliceContext,
  SliceDispatched,
} from "../../runtime/extension.ts";
import type { PlanWorkspace } from "../../runtime/protocol.ts";
import { regionIn } from "../../workshop/workflow.ts";
import { projectPath } from "../../workshop/workspace.ts";
import {
  ENDS_WITHOUT_VERDICT,
  lineOf,
  NO_RUNS,
  REACTIONS,
  regionOf,
  AGENT_REVIEW,
  REVIEWS_FILE,
  reviewsOf,
  SAMPLES,
  segmentOf,
  TRANSITIONS,
} from "./agent-review.ts";
import type { AgentReviewPlugs, Reviews, ReviewState } from "./contract.ts";
import { RULES, SLICE } from "./contract.ts";
import { REVIEWS_DIR, reviewFile } from "./names.ts";
import { BODIES, parseJson, parseReviews } from "./parse.ts";

type Context = SliceContext<AgentReviewPlugs>;

/** Before any event (F6): no row judges a directory the server lost. */
const DIRECTORY_GONE: Reply<never> = {
  refused: { status: 409, reason: "the plan's directory is gone" },
};

/** `null` when the working directory is gone and the server lost its memory: the route answers 409. */
function workspaceIfAny(context: Pick<ServerContext, "workspace">): Promise<PlanWorkspace | null> {
  return context.workspace().catch(() => null);
}

/** A file it cannot read starts over: the run it held reads as none, and the ✕ has nothing left to forget. */
async function readReviews(
  context: Pick<ServerContext, "readText">,
  dir: PlanWorkspace["dir"],
): Promise<Reviews> {
  const text = await context.readText(projectPath(`${dir}${REVIEWS_FILE}`));

  if (text === null) return NO_RUNS;
  const reviews = parseReviews(parseJson(text));

  if (reviews === null) console.error(`${REVIEWS_FILE} is unreadable, read as no run: ${text}`);

  return reviews ?? NO_RUNS;
}

function stateOf({ run, failed, stopping }: Reviews): ReviewState {
  return { run, failed, stopping };
}

/**
 * Where a verdict lands, read off the listing in the queue: `reviews/v<n>-<model>.md`, the next
 * free one. `""` when no run is running: the rows refuse such an end.
 */
async function verdictFile(
  context: Pick<ServerContext, "readText" | "listFiles">,
  workspace: PlanWorkspace,
): Promise<string> {
  const { run } = await readReviews(context, workspace.dir);

  if (run?.kind !== "running") return "";
  const listed = await context.listFiles(workspace.dir);
  const under = `${workspace.dir}${REVIEWS_DIR}`;

  const taken = new Set(
    listed.flatMap(({ path }) => (path.startsWith(under) ? [path.slice(under.length)] : [])),
  );

  return reviewFile(run.version, run.model, taken);
}

/** One event of the review's, once the directory is known to be there (F6); a refusal is its row's. */
async function stepped(
  context: Context,
  dispatch: () => Promise<SliceDispatched>,
): Promise<Reply<null>> {
  if ((await workspaceIfAny(context)) === null) return DIRECTORY_GONE;
  const { verdict } = await dispatch();

  return verdict.kind === "allow" ? { answer: null } : { refused: verdict };
}

export const server: ServerHalf<AgentReviewPlugs> = {
  id: "agent-review",
  bodies: BODIES,
  routes: {
    "GET state": (context) =>
      context.inOrder(async () => {
        const workspace = await workspaceIfAny(context);

        if (workspace === null) return DIRECTORY_GONE;

        return { answer: stateOf(await readReviews(context, workspace.dir)) };
      }),

    "POST request": async (context, { version }) => {
      if ((await workspaceIfAny(context)) === null) return DIRECTORY_GONE;

      const { verdict, workflow } = await context.dispatch("requestReview", {
        version: String(version),
      });

      if (verdict.kind !== "allow") return { refused: verdict };

      return { answer: { seq: reviewsOf(regionIn(workflow, AGENT_REVIEW)).seq } };
    },

    "POST launched": (context, { seq, agentId, model }) =>
      stepped(context, () =>
        context.dispatch("reviewLaunched", { seq: String(seq), agentId, model }),
      ),

    "POST ended": (context, { seq, outcome }) =>
      stepped(context, () =>
        context.dispatch("reviewDone", async (w) =>
          outcome.kind === "failed"
            ? { seq: String(seq), outcome: "failed", why: outcome.why, text: "", file: "" }
            : {
                seq: String(seq),
                outcome: "answer",
                why: "",
                text: outcome.text,
                file: await verdictFile(context, w.workspace),
              },
        ),
      ),

    "POST forget": (context, { seq }) =>
      stepped(context, () => context.dispatch("reviewForgotten", { seq: String(seq) })),

    // Refused once the plan is approved, as every event (P3); the agents to stop are answered all
    // the same, read off the runs, so the module stops the one the approval gave up (F7).
    "POST close": async (context) => {
      if ((await workspaceIfAny(context)) === null) return DIRECTORY_GONE;
      await context.dispatch("reviewClosed", {});
      const { dir } = await context.workspace();

      return { answer: { stopping: (await readReviews(context, dir)).stopping } };
    },

    // The one way an agent leaves the list: its stop confirmed, never a later write.
    "POST stopped": (context, { seq }) =>
      stepped(context, () => context.dispatch("reviewStopped", { seq: String(seq) })),
  },
  workflow: {
    events: SLICE.events,
    rules: RULES,
    samples: SAMPLES,
    transitions: TRANSITIONS,
    reactions: REACTIONS,
    endsWithoutVerdict: ENDS_WITHOUT_VERDICT,
    region: async (context) => {
      const { dir } = await context.workspace();

      return regionOf(await readReviews(context, dir));
    },
    segment: segmentOf,
    line: lineOf,
  },
};
