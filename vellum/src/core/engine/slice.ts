import type { HttpResponse } from "claude-code";

import type { Json, Parser } from "../plugs.ts";
import type {
  EngineContext,
  EngineExtension,
  ErasedContext,
  ErasedHooks,
  ExtensionTool,
  Listen,
  Listeners,
} from "./extension.ts";
import { parseJson, parseRefusal } from "./parse.ts";

/**
 * A slice's hooks half as the core takes it: its tools under their names, its listeners handed
 * a context whose client posts `JSON` to the half's own routes. The registry calls it, since a
 * hooks half loads its own folder alone.
 */

type Listening = { -readonly [Event in Listen]?: Listeners<EngineContext>[Event] };

/** `POST pause` is posted to `/api/x/<id>/pause`. */
function nameOf(route: string): string {
  return route.slice(route.indexOf(" ") + 1);
}

/** The answer `response` carries, read by the route's own parser; a route that answers nothing (`null`) takes any 2xx. */
function answerOf(
  response: HttpResponse,
  parse: Parser<Json> | null | undefined,
): { readonly read: true; readonly answer: Json } | { readonly read: false } {
  if (!response.ok || parse === undefined) return { read: false };

  if (parse === null) return { read: true, answer: null };
  const answer = parse(parseJson(response.text));

  return answer === null ? { read: false } : { read: true, answer };
}

function erased(context: EngineContext, half: ErasedHooks): ErasedContext {
  return {
    host: context.host,
    live: context.live,
    post: async (route, body) => {
      const response = await context.api.post(nameOf(route), JSON.stringify(body));
      const read = answerOf(response, half.answers[route]);

      if (read.read) {
        // SAFETY: `read.answer` is what this route's own parser in `answers` read, the answer its plugs declare for it: `HooksHalf` keys both by the same route.
        return { ok: true, answer: read.answer as never };
      }

      return {
        ok: false,
        status: response.status,
        text: response.text,
        reason: parseRefusal(response),
      };
    },
  };
}

function toolsOf(half: ErasedHooks): readonly ExtensionTool[] {
  return Object.entries(half.tools).map(([name, tool]) => ({
    ...tool,
    name,
    call: (context, input) =>
      tool.call({ ...erased(context, half), waiting: context.waiting }, input),
  }));
}

/** The listeners the half declares, each set only when present. */
function listeningOf(half: ErasedHooks): Listening {
  const listening: Listening = {};
  const { prompted, answered, agentAnswered, staged, closing } = half;

  if (prompted !== undefined) {
    listening.prompted = (context, prompt) => prompted(erased(context, half), prompt);
  }

  if (answered !== undefined) {
    listening.answered = (context, turn) => answered(erased(context, half), turn);
  }

  if (agentAnswered !== undefined) {
    listening.agentAnswered = (context, turn) => agentAnswered(erased(context, half), turn);
  }

  if (staged !== undefined) listening.staged = (context) => staged(erased(context, half));

  if (closing !== undefined) listening.closing = (context) => closing(erased(context, half));

  return listening;
}

export function engineExtension(half: ErasedHooks): EngineExtension {
  return { id: half.id, tools: toolsOf(half), ...listeningOf(half) };
}
