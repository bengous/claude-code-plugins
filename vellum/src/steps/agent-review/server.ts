import type {
  Reading,
  Route,
  RouteKey,
  ServerContext,
  ServerExtension,
} from "../../runtime/extension.ts";
import type { PlanWorkspace } from "../../runtime/protocol.ts";
import type { Actor, EventInput } from "../../workshop/workflow.ts";
import { projectPath } from "../../workshop/workspace.ts";
import { REVIEWS_DIR, reviewFile } from "./names.ts";
import { parseJson, parsePosts, parseReviews } from "./parse.ts";
import type { Closed, Requested, Reviews, ReviewState } from "./protocol.ts";
import {
  EVENTS,
  NO_RUNS,
  REACTION,
  regionOf,
  REVIEW,
  REVIEWS_FILE,
  RULES,
  lineOf,
  segmentOf,
  TRANSITIONS,
} from "./workflow.ts";

const NO_CONTENT = { status: 204 };

function refused(error: string): Response {
  return Response.json({ error }, { status: 409 });
}

function badRequest(): Response {
  return new Response("bad request", { status: 400 });
}

/** `null` when the working directory is gone and the server lost its memory: the route answers 409. */
function workspaceIfAny(context: ServerContext): Promise<PlanWorkspace | null> {
  return context.workspace().catch(() => null);
}

/** A file it cannot read starts over: the run it held reads as none, and the ✕ has nothing left to forget. */
async function readReviews(context: ServerContext, dir: PlanWorkspace["dir"]): Promise<Reviews> {
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
async function verdictFile(context: ServerContext, workspace: PlanWorkspace): Promise<string> {
  const { run } = await readReviews(context, workspace.dir);

  if (run?.kind !== "running") return "";
  const listed = await context.listFiles(workspace.dir);
  const under = `${workspace.dir}${REVIEWS_DIR}`;

  const taken = new Set(
    listed.flatMap(({ path }) => (path.startsWith(under) ? [path.slice(under.length)] : [])),
  );

  return reviewFile(run.version, run.model, taken);
}

function routes(context: ServerContext): Readonly<Record<RouteKey, Route>> {
  const { dispatch } = context;

  /** One event of the review's, once the directory is known to be there (F6); a refusal is its reason. */
  const stepped = async (
    event: string,
    input: EventInput | Reading,
    actor: Actor,
  ): Promise<Response | null> => {
    if ((await workspaceIfAny(context)) === null) return refused("the plan's directory is gone");
    const { verdict } = await dispatch(event, input, actor);

    return verdict.kind === "allow" ? null : refused(verdict.reason);
  };

  const done = (answer: Response | null): Response => answer ?? new Response(null, NO_CONTENT);

  return {
    "GET state": () =>
      context.inOrder(async () => {
        const workspace = await workspaceIfAny(context);

        if (workspace === null) return refused("the plan's directory is gone");

        return Response.json(stateOf(await readReviews(context, workspace.dir)));
      }),

    "POST request": async (request) => {
      const body = parsePosts.request(await request.json().catch(() => null));

      if (body === null) return badRequest();

      if ((await workspaceIfAny(context)) === null) return refused("the plan's directory is gone");
      const input = { version: String(body.version) };
      const { verdict, workflow } = await dispatch("requestReview", input, "reviewer");

      if (verdict.kind !== "allow") return refused(verdict.reason);
      const region = workflow.regions.find(({ id }) => id === REVIEW);
      const reviews = parseReviews(parseJson(String(region?.data.reviews)));

      if (reviews === null) throw new Error("a review asked left no runs to read");
      const requested: Requested = { seq: reviews.seq };

      return Response.json(requested);
    },

    "POST launched": async (request) => {
      const body = parsePosts.launched(await request.json().catch(() => null));

      if (body === null) return badRequest();
      const { seq, agentId, model } = body;

      return done(await stepped("reviewLaunched", { seq: String(seq), agentId, model }, "engine"));
    },

    "POST ended": async (request) => {
      const body = parsePosts.ended(await request.json().catch(() => null));

      if (body === null) return badRequest();
      const { seq, outcome } = body;

      const read: Reading = async (w) =>
        outcome.kind === "failed"
          ? { seq: String(seq), outcome: "failed", why: outcome.why }
          : {
              seq: String(seq),
              outcome: "answer",
              text: outcome.text,
              file: await verdictFile(context, w.workspace),
            };

      return done(await stepped("reviewDone", read, "engine"));
    },

    "POST forget": async (request) => {
      const body = parsePosts.forget(await request.json().catch(() => null));

      if (body === null) return badRequest();

      return done(await stepped("reviewForgotten", { seq: String(body.seq) }, "reviewer"));
    },

    // Refused once the plan is approved, as every event (P3); the agents to stop are answered all
    // the same, read off the runs, so the module stops the one the approval gave up (F7).
    "POST close": async (request) => {
      const body = parsePosts.close(await request.json().catch(() => null));

      if (body === null) return badRequest();

      if ((await workspaceIfAny(context)) === null) return refused("the plan's directory is gone");
      await dispatch("reviewClosed", {}, "engine");
      const { dir } = await context.workspace();
      const closed: Closed = { stopping: (await readReviews(context, dir)).stopping };

      return Response.json(closed);
    },

    // The one way an agent leaves the list: its stop confirmed, never a later write.
    "POST stopped": async (request) => {
      const body = parsePosts.stopped(await request.json().catch(() => null));

      if (body === null) return badRequest();

      return done(await stepped("reviewStopped", { seq: String(body.seq) }, "engine"));
    },
  };
}

export const reviewServer: ServerExtension = {
  id: "review",
  routes,
  workflow: {
    events: EVENTS,
    rules: RULES,
    transitions: TRANSITIONS,
    reaction: REACTION,
    region: async (context) => {
      const { dir } = await context.workspace();

      return regionOf(await readReviews(context, dir));
    },
    segment: segmentOf,
    line: lineOf,
  },
};
