import type { Route, RouteKey, ServerContext, ServerExtension } from "../../core/extension.ts";
import type { PlanWorkspace } from "../../core/protocol.ts";
import { regionIn } from "../../core/server/domain/workflow.ts";
import { projectPath } from "../../core/server/domain/workspace.ts";
import { parseAnswer, parseJson, parseProposal, parseProposalId, parseStepFile } from "./parse.ts";
import type { Paused, Proposed, StepFile, StepState, StepWaited } from "./protocol.ts";
import {
  EVENTS,
  fileOf,
  NO_SUCH_PROPOSAL,
  REACTION,
  regionOf,
  RULES,
  lineOf,
  segmentOf,
  STEP,
  STEP_FILE,
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

/** A file it cannot read reads as no proposal, and says so: nothing it held can be answered. */
async function readStep(context: ServerContext): Promise<StepFile | null> {
  const { dir } = await context.workspace();
  const text = await context.readText(projectPath(`${dir}${STEP_FILE}`));

  if (text === null) return null;
  const file = parseStepFile(parseJson(text));

  if (file === null) console.error(`${STEP_FILE} is unreadable, read as no proposal: ${text}`);

  return file;
}

/** Where the proposal `id` stands, as `step.json` says it: waiting, answered, dropped and why, or unknown. */
function waitedOn(file: StepFile | null, id: string): StepWaited {
  if (file?.pending?.id === id) return { kind: "open" };

  if (file?.answered?.id === id) {
    return { kind: "answered", seq: file.answered.seq, text: file.answered.text };
  }

  return file?.dropped?.id === id ? { kind: "ended", why: file.dropped.why } : { kind: "gone" };
}

function routes(context: ServerContext): Readonly<Record<RouteKey, Route>> {
  const { dispatch, inOrder } = context;

  return {
    // In the queue: a step writes step.json before it keeps its wait in memory, and a read between
    // the two would take a proposal Claude's call waits on for a paused one.
    "GET state": async () => {
      const region = regionIn(await inOrder(() => context.workflow()), STEP);

      const state: StepState = {
        pending: fileOf(region).pending,
        paused: region.state === "open" && region.wait === "paused",
      };

      return Response.json(state);
    },

    "POST propose": async (request) => {
      const proposal = parseProposal(await request.json().catch(() => null));

      if (proposal === null) return badRequest();

      if ((await workspaceIfAny(context)) === null) return refused("the plan's directory is gone");
      const proposed: Proposed = { id: crypto.randomUUID() };
      const input = { id: proposed.id, proposal: JSON.stringify(proposal) };
      const { verdict } = await dispatch("propose", input, "claude");

      return verdict.kind === "allow" ? Response.json(proposed) : refused(verdict.reason);
    },

    // A repost while Claude's call already waits is a keepalive: no step, no journal line (E4).
    "POST wait": async (request) => {
      const body = parseProposalId(await request.json().catch(() => null));

      if (body === null) return badRequest();
      const region = (await context.workflow()).regions.find(({ id }) => id === STEP);

      if (region?.state === "open" && region.data.pending === body.id && region.wait !== "open") {
        await dispatch("wait", { id: body.id }, "engine");
      }

      const waited = await context.hold(
        () => inOrder(async () => waitedOn(await readStep(context), body.id)),
        ({ kind }) => kind === "open",
      );

      return Response.json(waited);
    },

    // Claude's turn was cut while its call waited: nothing claims the pick now, which goes as a prompt.
    "POST pause": async (request) => {
      const body = parseProposalId(await request.json().catch(() => null));

      if (body === null) return badRequest();
      const { verdict } = await dispatch("pause", { id: body.id }, "engine");

      if (verdict.kind === "allow") {
        const paused: Paused = { wait: "paused" };

        return Response.json(paused);
      }

      return verdict.reason === NO_SUCH_PROPOSAL
        ? new Response(verdict.reason, { status: 404 })
        : refused(verdict.reason);
    },

    // The window's answer settles the proposal waiting, the one it showed or, opened blank, any:
    // a grill it opens holds the review, and a proposal left waiting under it would never end.
    "POST answer": async (request) => {
      const body = parseAnswer(await request.json().catch(() => null));

      if (body === null) return badRequest();

      if ((await workspaceIfAny(context)) === null) return refused("the plan's directory is gone");
      const { answer } = body;
      const move = answer.kind === "own" ? "own" : answer.move.kind;

      const subject =
        answer.kind === "move" && answer.move.kind === "grill" ? answer.move.subject : "";

      const { verdict } = await dispatch(
        "answerProposal",
        async () => ({
          id: body.id ?? "",
          answer: JSON.stringify(answer),
          move,
          subject,
          opened: move === "grill" ? await context.start("grill", { subject }) : "",
        }),
        "reviewer",
      );

      return verdict.kind === "allow" ? new Response(null, NO_CONTENT) : refused(verdict.reason);
    },
  };
}

export const stepServer: ServerExtension = {
  id: "step",
  routes,
  workflow: {
    events: EVENTS,
    rules: RULES,
    transitions: TRANSITIONS,
    reaction: REACTION,
    region: async (context, before) => regionOf(await readStep(context), before),
    segment: segmentOf,
    line: lineOf,
  },
};
