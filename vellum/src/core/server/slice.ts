import type {
  ErasedHandler,
  ErasedSliceContext,
  Reply,
  Route,
  ServerContext,
  ServerExtension,
  ServerHalf,
} from "../extension.ts";
import type { Json, Parser, Plugs } from "../plugs.ts";
import type { Events } from "./domain/rows.ts";
import { tablePart } from "./domain/rows.ts";
import type { Actor } from "./domain/workflow.ts";

/**
 * A slice's server half as the core takes it: each route parses its body with the half's own
 * parser, 400 when it is not one, runs its handler, and answers its reply; each event is
 * dispatched as its declared sender; the workflow part becomes the `TablePart` `next` judges.
 */

function senderOf(declared: Events, event: string): Actor {
  const sender = declared[event]?.by;

  if (sender === undefined) throw new Error(`no event ${event} in this slice`);

  return sender;
}

function sliceContext(context: ServerContext, declared: Events): ErasedSliceContext {
  return {
    ...context,
    dispatch: (event, input) => context.dispatch(event, input, senderOf(declared, event)),
  };
}

function responseOf(reply: Reply<Json>): Response {
  if ("refused" in reply) {
    return reply.refused === 404
      ? new Response(reply.reason, { status: 404 })
      : Response.json({ error: reply.reason }, { status: 409 });
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

  return {
    id: half.id,
    routes: (context) => {
      const bound = sliceContext(context, half.workflow.events);

      return Object.fromEntries(
        Object.entries(handlers).map(([key, handler]): [string, Route] => [
          key,
          routeOf(handler, bodies[key], bound),
        ]),
      );
    },
    workflow: { ...tablePart(half.id, half.workflow), region, segment, line },
  };
}
