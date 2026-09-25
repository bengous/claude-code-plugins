import type { Route, RouteKey, ServerContext, ServerExtension } from "../../core/extension.ts";
import type { PlanWorkspace } from "../../core/protocol.ts";
import { projectPath, REVIEW_DIR } from "../../core/server/domain/workspace.ts";
import { REVIEWS_DIR, reviewFile } from "./names.ts";
import { parseJson, parsePosts, parseReviews } from "./parse.ts";
import type { Closed, Requested, Reviews, ReviewState } from "./protocol.ts";
import { REVIEWER } from "./protocol.ts";

/** Where the server keeps the runs, so a restarted one still knows the run under way and its number. */
const REVIEWS_FILE = `${REVIEW_DIR}/reviews.json`;

const NONE: Reviews = { seq: 0, run: null, failed: null, stopping: [], resubmit: false };

const NO_CONTENT = { status: 204 };

const NO_SUCH_RUN = "no such run";

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

  if (text === null) return NONE;
  const reviews = parseReviews(parseJson(text));

  if (reviews === null) console.error(`${REVIEWS_FILE} is unreadable, read as no run: ${text}`);

  return reviews ?? NONE;
}

function writeReviews(
  context: ServerContext,
  dir: PlanWorkspace["dir"],
  reviews: Reviews,
): Promise<void> {
  return context.writeText(projectPath(`${dir}${REVIEWS_FILE}`), `${JSON.stringify(reviews)}\n`);
}

function stateOf({ run, failed, stopping, resubmit }: Reviews): ReviewState {
  return { run, failed, stopping, resubmit };
}

/**
 * The run given up, its agent to stop once it has one, and `plan.md` to submit again: a version
 * Claude wrote while the run held the review was refused.
 */
function givenUp(reviews: Reviews): Reviews {
  const { run, stopping } = reviews;
  const agent = run?.kind === "running" ? [{ seq: run.seq, agentId: run.agentId }] : [];

  return { ...reviews, run: null, stopping: [...stopping, ...agent], resubmit: true };
}

/** Why no review of `version` is asked now; `null` when one may be. One hold at a time: another's refuses it. */
async function whyNot(
  context: ServerContext,
  workspace: PlanWorkspace,
  reviews: Reviews,
  version: number,
): Promise<string | null> {
  if (workspace.kind === "drafting") return "no version is under review yet";

  if (workspace.kind === "approved") return "the plan is approved";

  if (workspace.version !== version)
    return `v${workspace.version} is under review, not v${version}`;

  if (reviews.run !== null) return `a review of v${reviews.run.version} is running`;

  return await context.held();
}

function twoDigits(n: number): string {
  return String(n).padStart(2, "0");
}

/** The agent's text as it wrote it, under vellum's header: the version, the agent, its model, the time of the write. */
function verdictDoc(version: number, model: string, text: string, at: Date): string {
  const time = `${twoDigits(at.getHours())}:${twoDigits(at.getMinutes())}`;

  return `# Plan review · v${version}\n\n\`${REVIEWER}\` · \`${model}\` · ${time}\n\n${text.trimEnd()}\n`;
}

/** What a route makes of the runs: the record to write, and the answer once it is written. */
type Changed = { readonly reviews: Reviews; readonly answer: Response };

/**
 * A run under way holds the review, from its request to its end: no version of Claude's is
 * recorded, and `step` takes no proposal. Its number is part of the reason, which the approval's
 * warning compares. Read outside `inOrder`, since the queue calls it; a directory gone holds nothing.
 */
async function holds(context: ServerContext): Promise<string | null> {
  const workspace = await workspaceIfAny(context);

  if (workspace === null) return null;
  const { run } = await readReviews(context, workspace.dir);

  return run === null ? null : `plan review ${run.seq} of v${run.version} is running`;
}

/** The approval gives up the run under way: an answer that comes later finds no run, and writes nothing. */
async function approved(context: ServerContext): Promise<void> {
  const { dir } = await context.workspace();
  const reviews = await readReviews(context, dir);

  if (reviews.run !== null) await writeReviews(context, dir, givenUp(reviews));
}

function routes(context: ServerContext): Readonly<Record<RouteKey, Route>> {
  const { inOrder } = context;

  /** Reads the runs at write time, in the queue: after an approval the directory has moved. */
  const change = (
    apply: (
      reviews: Reviews,
      workspace: PlanWorkspace,
    ) => Changed | Response | Promise<Changed | Response>,
  ): Promise<Response> =>
    inOrder(async () => {
      const workspace = await workspaceIfAny(context);

      if (workspace === null) return refused("the plan's directory is gone");
      const applied = await apply(await readReviews(context, workspace.dir), workspace);

      if (applied instanceof Response) return applied;
      await writeReviews(context, workspace.dir, applied.reviews);
      await context.notify();

      return applied.answer;
    });

  const done = (reviews: Reviews): Changed => ({
    reviews,
    answer: new Response(null, NO_CONTENT),
  });

  return {
    "GET state": async () => {
      const workspace = await workspaceIfAny(context);

      if (workspace === null) return refused("the plan's directory is gone");
      const state: ReviewState = stateOf(await readReviews(context, workspace.dir));

      return Response.json(state);
    },

    "POST request": async (request) => {
      const body = parsePosts.request(await request.json().catch(() => null));

      if (body === null) return badRequest();

      return await change(async (reviews, workspace) => {
        const why = await whyNot(context, workspace, reviews, body.version);

        if (why !== null) return refused(why);
        const seq = reviews.seq + 1;
        const requested: Requested = { seq };
        const run = { kind: "requested", seq, version: body.version } as const;

        return {
          reviews: { ...reviews, seq, run, failed: null },
          answer: Response.json(requested),
        };
      });
    },

    "POST launched": async (request) => {
      const body = parsePosts.launched(await request.json().catch(() => null));

      if (body === null) return badRequest();

      return await change((reviews) => {
        const { run } = reviews;

        if (run?.kind !== "requested" || run.seq !== body.seq) return refused(NO_SUCH_RUN);

        return done({ ...reviews, run: { ...run, ...body, kind: "running" } });
      });
    },

    "POST ended": async (request) => {
      const body = parsePosts.ended(await request.json().catch(() => null));

      if (body === null) return badRequest();

      return await change(async (reviews, workspace) => {
        const { run } = reviews;

        if (run === null || run.seq !== body.seq) return refused(NO_SUCH_RUN);
        const { outcome } = body;

        if (outcome.kind === "failed") {
          const model = run.kind === "running" ? run.model : null;
          const failed = { seq: run.seq, version: run.version, model, why: outcome.why };

          return done({ ...reviews, run: null, failed, resubmit: true });
        }

        if (run.kind !== "running") return refused("the run was never launched");
        const listed = await context.listFiles(workspace.dir);
        const under = `${workspace.dir}${REVIEWS_DIR}`;

        const taken = new Set(
          listed.flatMap(({ path }) => (path.startsWith(under) ? [path.slice(under.length)] : [])),
        );

        const file = projectPath(`${workspace.dir}${reviewFile(run.version, run.model, taken)}`);
        await context.writeText(file, verdictDoc(run.version, run.model, outcome.text, new Date()));

        return done({ ...reviews, run: null, failed: null, resubmit: true });
      });
    },

    "POST forget": async (request) => {
      const body = parsePosts.forget(await request.json().catch(() => null));

      if (body === null) return badRequest();

      return await change((reviews) =>
        reviews.run?.seq === body.seq ? done(givenUp(reviews)) : refused(NO_SUCH_RUN),
      );
    },

    // `/vellum:stop` and the approval: the mode closes, so nothing is submitted again.
    "POST close": async (request) => {
      const body = parsePosts.close(await request.json().catch(() => null));

      if (body === null) return badRequest();

      return await change((reviews) => {
        const closed = { ...givenUp(reviews), resubmit: reviews.resubmit };
        const answer: Closed = { stopping: closed.stopping };

        return { reviews: closed, answer: Response.json(answer) };
      });
    },

    // The one way an agent leaves the list: its stop confirmed, never a later write.
    "POST stopped": async (request) => {
      const body = parsePosts.stopped(await request.json().catch(() => null));

      if (body === null) return badRequest();

      return await change((reviews) => {
        const stopping = reviews.stopping.filter(({ seq }) => seq !== body.seq);

        return stopping.length === reviews.stopping.length
          ? refused(NO_SUCH_RUN)
          : done({ ...reviews, stopping });
      });
    },

    "POST resubmitted": async (request) => {
      const body = parsePosts.resubmitted(await request.json().catch(() => null));

      if (body === null) return badRequest();

      return await change((reviews) => done({ ...reviews, resubmit: false }));
    },
  };
}

export const reviewServer: ServerExtension = { id: "review", routes, holds, approved };
