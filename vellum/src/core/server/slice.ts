import type {
  Dispatched,
  ErasedHandler,
  ErasedServerParts,
  ErasedSliceContext,
  Reply,
  Route,
  ServerContext,
  ServerExtension,
  ServerHalf,
  SliceVerdict,
} from "../extension.ts";
import type { Json, Parser, Plugs } from "../plugs.ts";
import type { Events } from "./domain/rows.ts";
import { tablePart } from "./domain/rows.ts";
import type { Actor, RefusalStatus, TablePart } from "./domain/workflow.ts";
import { HELD } from "./domain/workflow.ts";

/**
 * A slice's server half as the core takes it: each route parses its input with the half's own
 * parser (a POST's body, a GET's query), 400 when it is not one, runs its handler, and answers its
 * reply; each event is dispatched as its declared sender, and a refusal carries the status its
 * row declares; what opens it and its part of the Send, when it has them; the workflow part
 * becomes the `TablePart` `next` judges.
 */

/** What a refusal by a row the slice does not own answers: the core's, another slice's. */
const FOREIGN: RefusalStatus = 409;

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

/** The status of the row `rule` of `event`, as the slice's own part declares it. */
function statusOf(part: TablePart, event: string, rule: string): RefusalStatus {
  if (rule === HELD) {
    const held = part.events.find(({ id }) => id === event)?.whileHeld;

    return held?.effect === "allow" ? FOREIGN : (held?.status ?? FOREIGN);
  }

  return part.rules.find((row) => row.event === event && row.id === rule)?.status ?? FOREIGN;
}

function verdictOf(part: TablePart, event: string, { verdict }: Dispatched): SliceVerdict {
  return verdict.kind === "allow"
    ? verdict
    : { ...verdict, status: statusOf(part, event, verdict.rule) };
}

function sliceContext(
  context: ServerContext,
  declared: Events,
  part: TablePart,
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

export function serverExtension<P extends Plugs>(half: ServerHalf<P>): ServerExtension {
  const handlers: { readonly [route: string]: ErasedHandler } = half.routes;
  const bodies: { readonly [route: string]: Parser<Json> } = half.bodies;
  const parts: ErasedServerParts = half;
  const { region, segment, line, walk } = half.workflow;
  const part = tablePart(half.id, half.workflow);

  const bound = (context: ServerContext): ErasedSliceContext =>
    sliceContext(context, half.workflow.events, part);

  return {
    id: half.id,
    routes: (context) =>
      Object.fromEntries(
        Object.entries(handlers).map(([key, handler]): [string, Route] => [
          key,
          routeOf(key, handler, bodies[key], bound(context)),
        ]),
      ),
    ...partsOf(parts, bound),
    workflow: { ...part, region, segment, line, walk },
  };
}
