import type { Json, Parser, Plugs } from "../../workshop/plugs.ts";
import type { Events } from "../../workshop/rows.ts";
import { tablePart } from "../../workshop/rows.ts";
import type { Actor, TablePart } from "../../workshop/workflow.ts";
import { statusOf } from "../../workshop/workflow.ts";
import type {
  Dispatched,
  ErasedHandler,
  ErasedServerParts,
  ErasedSliceContext,
  LinkedDocs,
  Reply,
  Route,
  ServerContext,
  ServerExtension,
  ServerHalf,
  SliceDispatched,
  SliceVerdict,
  SliceWorkflow,
} from "../extension.ts";

/**
 * A slice's server half as the core takes it: each route parses its input with the half's own
 * parser (a POST's body, a GET's query), 400 when it is not one, runs its handler, and answers its
 * reply; each event is dispatched as its declared sender, and a refusal carries the status its
 * row declares; what opens it and its part of the Send, when it has them; the workflow part
 * becomes the `TablePart` `next` judges.
 */

/**
 * A `POST wait` of a call that waits on `id` in `region`: a wait a pause or a restart left paused
 * opens again through `reopen`, the slice's event that marks it open; then the route holds, under
 * the engine's cut, until `read` says the wait ended, or for the hold at most. A repost while the
 * call already waits is a keepalive: no step, no journal line (E4).
 */
export async function heldWait<W extends { readonly kind: string }>(
  context: Pick<ServerContext, "workflow" | "hold" | "inOrder">,
  region: string,
  id: string,
  reopen: () => Promise<SliceDispatched>,
  read: () => Promise<W>,
): Promise<Reply<W>> {
  const waiting = (await context.workflow()).regions.find((one) => one.id === region);

  if (waiting?.state === "open" && waiting.data.pending === id && waiting.wait !== "open") {
    await reopen();
  }

  return {
    answer: await context.hold(
      () => context.inOrder(read),
      ({ kind }) => kind === "open",
    ),
  };
}

/** The sender a route named, else the event's one sender. */
function senderOf(declared: Events, event: string, by: Actor | undefined): Actor {
  const senders = declared[event]?.by;

  if (senders === undefined) throw new Error(`no event ${event} in this slice`);
  const sender = by ?? (senders.length === 1 ? senders[0] : undefined);

  if (sender === undefined || !senders.includes(sender)) {
    throw new Error(`${event} is sent by ${senders.join(" or ")}, not ${by ?? "nobody named"}`);
  }

  return sender;
}

function verdictOf(part: TablePart | null, event: string, { verdict }: Dispatched): SliceVerdict {
  return verdict.kind === "allow"
    ? verdict
    : { ...verdict, status: statusOf(part, event, verdict.rule) };
}

function sliceContext(
  context: ServerContext,
  declared: Events,
  part: TablePart | null,
): ErasedSliceContext {
  return {
    ...context,
    dispatch: async (event, input, by) => {
      const dispatched = await context.dispatch(event, input, senderOf(declared, event, by));

      return { ...dispatched, verdict: verdictOf(part, event, dispatched) };
    },
  };
}

function responseOf(reply: Reply<Json>): Response {
  if ("refused" in reply) {
    const { status, reason } = reply.refused;

    return status === 409
      ? Response.json({ error: reason }, { status })
      : new Response(reason, { status });
  }

  return reply.answer === null ? new Response(null, { status: 204 }) : Response.json(reply.answer);
}

/** What a route reads of its request, unread: a GET's query as an object, a POST's JSON body. */
// oxlint-disable-next-line anti-slop/no-unknown-returns -- the request's input before its route's parser: the parser, the boundary, is what types it.
async function inputOf(key: string, request: Request): Promise<unknown> {
  if (key.startsWith("GET ")) return Object.fromEntries(new URL(request.url).searchParams);

  return await request.json().catch(() => null);
}

function routeOf(
  key: string,
  handler: ErasedHandler,
  parse: Parser<Json> | undefined,
  context: ErasedSliceContext,
): Route {
  return async (request) => {
    const input = parse === undefined ? undefined : parse(await inputOf(key, request));

    if (input === null) return new Response("bad request", { status: 400 });

    // SAFETY: `input` is what this route's own parser answered, the type its handler takes, both keyed by the same route in `ServerHalf`; a route with no parser reads nothing of its request, and its handler takes no input.
    return responseOf(await handler(context, input as never));
  };
}

/** `start` and `part` as `ServerExtension` takes them, each present when the half has it. */
function partsOf(
  half: ErasedServerParts,
  bound: (context: ServerContext) => ErasedSliceContext,
): Pick<ServerExtension, "start" | "part"> {
  const extension: { -readonly [Key in "start" | "part"]?: ServerExtension[Key] } = {};
  const { opened, start, part } = half;

  if (opened !== undefined && start !== undefined) {
    extension.start = async (context, raw) => {
      const input = opened(raw);

      // SAFETY: `input` is what the half's own `opened` parser answered, the type its `start` takes: `ServerHalf` types both by the plugs' `opened`.
      return input === null ? "" : await start(bound(context), input as never);
    };
  }

  if (part !== undefined) {
    extension.part = async (context, draft, takeDefaults) => {
      const share = await part(bound(context), draft, takeDefaults);

      return share.kind === "part" ? { ...share, input: JSON.stringify(share.input) } : share;
    };
  }

  return extension;
}

/** What `ServerExtension` takes of the half's own: its routes, its part of the workflow, its linked documents, each when it has them. */
type Owned = Pick<ServerExtension, "routes" | "workflow" | "linkedDocs">;

export function serverExtension<P extends Plugs>(half: ServerHalf<P>): ServerExtension {
  const handlers: { readonly [route: string]: ErasedHandler } | undefined = half.routes;
  const bodies: { readonly [route: string]: Parser<Json> } | undefined = half.bodies;
  const workflow: SliceWorkflow<P["events"], P["hears"]> | undefined = half.workflow;
  const linkedDocs: LinkedDocs | undefined = half.linkedDocs;
  const parts: ErasedServerParts = half;
  const part = workflow === undefined ? null : tablePart(half.id, workflow);

  const bound = (context: ServerContext): ErasedSliceContext =>
    sliceContext(context, workflow?.events ?? {}, part);

  const owned: { -readonly [Key in keyof Owned]?: Owned[Key] } = {};

  if (handlers !== undefined) {
    owned.routes = (context) =>
      Object.fromEntries(
        Object.entries(handlers).map(([key, handler]): [string, Route] => [
          key,
          routeOf(key, handler, bodies?.[key], bound(context)),
        ]),
      );
  }

  if (workflow !== undefined && part !== null) {
    const { region, segment, line } = workflow;
    owned.workflow = { ...part, region, segment, line };
  }

  if (linkedDocs !== undefined) owned.linkedDocs = linkedDocs;

  return { id: half.id, ...owned, ...partsOf(parts, bound) };
}
