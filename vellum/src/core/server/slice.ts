import type {
  Dispatched,
  ErasedHandler,
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
 * A slice's server half as the core takes it: each route parses its body with the half's own
 * parser, 400 when it is not one, runs its handler, and answers its reply; each event is
 * dispatched as its declared sender, and a refusal carries the status its row declares; the
 * workflow part becomes the `TablePart` `next` judges.
 */

/** What a refusal by a row the slice does not own answers: the core's, another slice's. */
const FOREIGN: RefusalStatus = 409;

function senderOf(declared: Events, event: string): Actor {
  const sender = declared[event]?.by;

  if (sender === undefined) throw new Error(`no event ${event} in this slice`);

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
    dispatch: async (event, input) => {
      const dispatched = await context.dispatch(event, input, senderOf(declared, event));

      return { ...dispatched, verdict: verdictOf(part, event, dispatched) };
    },
  };
}

function responseOf(reply: Reply<Json>): Response {
  if ("refused" in reply) {
    const { status, reason } = reply.refused;

    return status === 404
      ? new Response(reason, { status })
      : Response.json({ error: reason }, { status });
  }

  return reply.answer === null ? new Response(null, { status: 204 }) : Response.json(reply.answer);
}

function routeOf(
  handler: ErasedHandler,
  parse: Parser<Json> | undefined,
  context: ErasedSliceContext,
): Route {
  return async (request) => {
    const body = parse === undefined ? undefined : parse(await request.json().catch(() => null));

    if (body === null) return new Response("bad request", { status: 400 });

    // SAFETY: `body` is what this route's own parser answered, the type its handler takes, both keyed by the same route in `ServerHalf`; a GET has no parser, and its handler takes no body.
    return responseOf(await handler(context, body as never));
  };
}

export function serverExtension<P extends Plugs>(half: ServerHalf<P>): ServerExtension {
  const handlers: { readonly [route: string]: ErasedHandler } = half.routes;
  const bodies: { readonly [route: string]: Parser<Json> } = half.bodies;
  const { region, segment, line } = half.workflow;
  const part = tablePart(half.id, half.workflow);

  return {
    id: half.id,
    routes: (context) => {
      const bound = sliceContext(context, half.workflow.events, part);

      return Object.fromEntries(
        Object.entries(handlers).map(([key, handler]): [string, Route] => [
          key,
          routeOf(handler, bodies[key], bound),
        ]),
      );
    },
    workflow: { ...part, region, segment, line },
  };
}
