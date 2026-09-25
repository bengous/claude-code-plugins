import type { Route, RouteKey, ServerContext, ServerExtension } from "../../core/extension.ts";
import type { PlanWorkspace } from "../../core/protocol.ts";
import { answerText, ownText } from "./moves.ts";
import { parseAnswer, parseProposal, parseWait } from "./parse.ts";
import type { Dropped, Pending, Proposed, StepState, StepWaited } from "./protocol.ts";

/** A proposal the reviewer answered, under the entry that told it: what a waiting `propose` returns. */
type Answered = { readonly id: string; readonly seq: number; readonly text: string };

/**
 * What the server keeps of the proposals while it runs, per review: one waits at a time, and a
 * newer one replaces it. A restarted server keeps nothing, and a wait on a proposal it does not
 * know reads as gone: Claude proposes again.
 */
type Memory = {
  pending: Pending | null;
  /** The last proposal answered, for the waits on it. */
  answered: Answered | null;
  /** The last proposal dropped unanswered, and why, for the waits on it. */
  dropped: { readonly id: string; readonly why: Dropped } | null;
};

const memories = new WeakMap<ServerContext, Memory>();

function memoryOf(context: ServerContext): Memory {
  const known = memories.get(context);

  if (known !== undefined) return known;
  const made: Memory = { pending: null, answered: null, dropped: null };
  memories.set(context, made);

  return made;
}

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

/** Why no step is taken now: the directory gone, or the plan approved. */
async function ended(context: ServerContext): Promise<string | null> {
  const workspace = await workspaceIfAny(context);

  if (workspace === null) return "the plan's directory is gone";

  return workspace.kind === "approved" ? "the plan is approved" : null;
}

function waitedOn(memory: Memory, id: string): StepWaited {
  if (memory.pending?.id === id) return { kind: "open" };
  const { answered, dropped } = memory;

  if (answered?.id === id) return { kind: "answered", seq: answered.seq, text: answered.text };

  return dropped?.id === id ? { kind: "ended", why: dropped.why } : { kind: "gone" };
}

/** The approval takes the proposal with it: a `propose` waiting on it reads it gone. */
function approved(context: ServerContext): Promise<void> {
  const memory = memoryOf(context);

  if (memory.pending !== null) memory.dropped = { id: memory.pending.id, why: "approved" };
  memory.pending = null;
  context.wake();

  return Promise.resolve();
}

function routes(context: ServerContext): Readonly<Record<RouteKey, Route>> {
  const { inOrder } = context;
  const memory = memoryOf(context);

  return {
    "GET state": () => {
      const state: StepState = { pending: memory.pending };

      return Promise.resolve(Response.json(state));
    },

    "POST propose": async (request) => {
      const proposal = parseProposal(await request.json().catch(() => null));

      if (proposal === null) return badRequest();

      return await inOrder(async () => {
        const why = await ended(context);

        if (why !== null) return refused(why);
        const held = await context.held();

        if (held !== null) return refused(`${held}: no step is proposed until it ends`);
        const proposed: Proposed = { id: crypto.randomUUID() };

        if (memory.pending !== null) memory.dropped = { id: memory.pending.id, why: "replaced" };
        memory.pending = { id: proposed.id, proposal };
        context.wake();
        await context.notify();

        return Response.json(proposed);
      });
    },

    // Out of the queue: an answer updates the memory in one synchronous step, after its entry.
    "POST wait": async (request) => {
      const body = parseWait(await request.json().catch(() => null));

      if (body === null) return badRequest();

      const waited = await context.hold(
        () => Promise.resolve(waitedOn(memory, body.id)),
        ({ kind }) => kind === "open",
      );

      return Response.json(waited);
    },

    // The window's answer settles the proposal waiting, the one it showed or, opened blank, any:
    // a grill it opens holds the review, and a proposal left waiting under it would never end.
    // It decides first and writes nothing; its entry is the commit point, then the start's write.
    "POST answer": async (request) => {
      const body = parseAnswer(await request.json().catch(() => null));

      if (body === null) return badRequest();

      return await inOrder(async () => {
        const why = (await ended(context)) ?? (await context.held());

        if (why !== null) return refused(why);
        const { pending } = memory;

        if (body.id !== null && pending?.id !== body.id) return refused("no such proposal");
        const { answer } = body;

        const started =
          answer.kind === "move" && answer.move.kind === "grill"
            ? await context.start("grill", { subject: answer.move.subject })
            : null;

        if (started?.ok === false) return refused(started.error);

        const told =
          body.id === null ? ownText(answer, pending !== null) : answerText(answer, pending);

        const text = started === null ? told : `${told} ${started.value.told}`;
        const seq = await context.relay({ kind: "text", from: "step", text });

        if (pending !== null) {
          memory.answered = { id: pending.id, seq, text };
          memory.pending = null;
        }

        context.wake();
        await started?.value.commit().catch((cause: unknown) => {
          console.error(`step told Claude of its answer, then the start failed: ${String(cause)}`);
        });
        await context.notify();

        return new Response(null, NO_CONTENT);
      });
    },
  };
}

export const stepServer: ServerExtension = { id: "step", routes, approved };
