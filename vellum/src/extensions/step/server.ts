import type { Route, RouteKey, ServerContext, ServerExtension } from "../../core/extension.ts";
import type { PlanWorkspace } from "../../core/protocol.ts";
import { answerText } from "./moves.ts";
import { parseAnswer, parseProposal, parseWait } from "./parse.ts";
import type { Pending, Proposed, StepState, StepWaited } from "./protocol.ts";

/**
 * How long `POST wait` holds before it answers that the proposal still waits: under the 30 s at
 * which the engine cuts every `$.http.fetch` (`docs/plugin-testing/hook-runtime.md`).
 */
const WAIT_HOLD_MS = 25_000;

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
  /** The waits held now, each woken to read again once the proposal may have moved. */
  readonly waiting: Set<() => void>;
};

const memories = new WeakMap<ServerContext, Memory>();

function memoryOf(context: ServerContext): Memory {
  const known = memories.get(context);

  if (known !== undefined) return known;
  const made: Memory = { pending: null, answered: null, waiting: new Set() };
  memories.set(context, made);

  return made;
}

function wake(memory: Memory): void {
  for (const waiter of memory.waiting) waiter();
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
  const { answered } = memory;

  return answered?.id === id
    ? { kind: "answered", seq: answered.seq, text: answered.text }
    : { kind: "gone" };
}

/** The approval takes the proposal with it: a `propose` waiting on it reads it gone. */
function approved(context: ServerContext): Promise<void> {
  const memory = memoryOf(context);
  memory.pending = null;
  wake(memory);

  return Promise.resolve();
}

function routes(context: ServerContext): Readonly<Record<RouteKey, Route>> {
  const { inOrder } = context;
  const memory = memoryOf(context);

  return {
    "GET state": async () => {
      const state: StepState = { pending: memory.pending, held: await context.held() };

      return Response.json(state);
    },

    "POST propose": async (request) => {
      const proposal = parseProposal(await request.json().catch(() => null));

      if (proposal === null) return badRequest();

      return await inOrder(async () => {
        const why = await ended(context);

        if (why !== null) return refused(why);
        const held = await context.held();

        if (held !== null)
          return refused(`${held}: no step is proposed until the reviewer ends it`);
        const proposed: Proposed = { id: crypto.randomUUID() };
        memory.pending = { id: proposed.id, proposal };
        wake(memory);
        await context.notify();

        return Response.json(proposed);
      });
    },

    // Read in the queue, so an answer's step is seen whole: its entry and the proposal it settled.
    "POST wait": async (request) => {
      const body = parseWait(await request.json().catch(() => null));

      if (body === null) return badRequest();
      const until = Date.now() + WAIT_HOLD_MS;

      for (;;) {
        const waited = await inOrder(() => Promise.resolve(waitedOn(memory, body.id)));
        const left = until - Date.now();

        if (waited.kind !== "open" || left <= 0) return Response.json(waited);

        await new Promise<void>((resolve) => {
          const woken = (): void => {
            clearTimeout(timer);
            memory.waiting.delete(woken);
            resolve();
          };

          const timer = setTimeout(woken, left);
          memory.waiting.add(woken);
        });
      }
    },

    // The window's answer settles the proposal waiting, the one it showed or, opened blank, any:
    // a grill it opens holds the review, and a proposal left waiting under it would never end.
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
        const told = answerText(answer, pending);
        const text = started === null ? told : `${told} ${started.value}`;
        const seq = await context.relay({ kind: "text", from: "step", text });

        if (pending !== null) {
          memory.answered = { id: pending.id, seq, text };
          memory.pending = null;
        }

        wake(memory);
        await context.notify();

        return new Response(null, NO_CONTENT);
      });
    },
  };
}

export const stepServer: ServerExtension = { id: "step", routes, approved };
