import type { HttpResponse } from "claude-code";

import type { Json, Parser } from "../plugs.ts";
import type {
  EngineContext,
  EngineExtension,
  ErasedContext,
  ErasedHold,
  ErasedHooks,
  ErasedToolContext,
  ExtensionTool,
  Listen,
  Listeners,
  ToolAnswer,
  ToolContext,
} from "./extension.ts";
import type { Live } from "./mode.ts";
import { parseJson, parseRefusal } from "./parse.ts";
import type { ChannelEntryWire } from "./parse.ts";

/**
 * A slice's hooks half as the core takes it: its tools under their names, its listeners handed
 * a context whose client posts `JSON` to the half's own routes, and a tool's wait for the
 * reviewer, with what it waits on kept by mode until it ends. The registry calls it, since a
 * hooks half loads its own folder alone.
 */

type Listening = { -readonly [Event in Listen]?: Listeners<EngineContext>[Event] };

/** What each mode's call waited on and heard nothing back for, one map per half. */
type Marks = WeakMap<Live, string>;

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

function erased(context: EngineContext, half: ErasedHooks, marks: Marks): ErasedContext {
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
    unanswered: () => {
      const mark = marks.get(context.live);
      marks.delete(context.live);

      return mark;
    },
  };
}

/** One post of the wait, asked again at once while `attempts` allows it; the last failure throws. */
async function waitedOnce(context: ErasedContext, hold: ErasedHold): Promise<never> {
  for (let tries = 1; ; tries += 1) {
    const posted = await context.post(hold.route, hold.body).catch(() => null);

    if (posted?.ok === true) return posted.answer;

    if (tries >= hold.attempts) {
      const why = posted === null ? "no answer" : `${posted.status} ${posted.text.slice(0, 200)}`;

      throw new Error(`${hold.route} failed ${String(tries)} time(s): ${why}`);
    }
  }
}

/**
 * Holds the call until the reviewer answers, one post in flight at a time: the engine cuts each
 * at 30 s and counts no hook time while one is out (`docs/plugin-testing/hook-runtime.md`). The
 * mark is kept from the call's start to its answer, so a turn cut short reads it back.
 */
function waitFor(
  context: ToolContext,
  slice: ErasedContext,
  marks: Marks,
): ErasedToolContext["waitFor"] {
  return async (hold): Promise<ToolAnswer> => {
    marks.set(context.live, hold.mark);
    context.waiting();

    for (;;) {
      const answer = hold.settle(await waitedOnce(slice, hold));

      if (answer === null) continue;
      marks.delete(context.live);

      return answer;
    }
  };
}

/** The entries a tool's call may return: `"own"` for the text entries of the half's own slice. */
function awaitsOf(
  id: string,
  awaits: ErasedHooks["tools"][string]["awaits"],
): ((entry: ChannelEntryWire) => boolean) | undefined {
  return awaits === "own" ? (entry) => entry.kind === "text" && entry.from === id : awaits;
}

function toolsOf(half: ErasedHooks, marks: Marks): readonly ExtensionTool[] {
  return Object.entries(half.tools).map(([name, tool]) => {
    const awaits = awaitsOf(half.id, tool.awaits);

    const extension: ExtensionTool = {
      name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      call: (context, input) => {
        const slice = erased(context, half, marks);

        return tool.call({ ...slice, waitFor: waitFor(context, slice, marks) }, input);
      },
    };

    return awaits === undefined ? extension : { ...extension, awaits };
  });
}

/** The listeners the half declares, each set only when present. */
function listeningOf(half: ErasedHooks, marks: Marks): Listening {
  const listening: Listening = {};
  const { prompted, answered, agentAnswered, staged, closing } = half;

  if (prompted !== undefined) {
    listening.prompted = (context, prompt) => prompted(erased(context, half, marks), prompt);
  }

  if (answered !== undefined) {
    listening.answered = (context, turn) => answered(erased(context, half, marks), turn);
  }

  if (agentAnswered !== undefined) {
    listening.agentAnswered = (context, turn) => agentAnswered(erased(context, half, marks), turn);
  }

  if (staged !== undefined) listening.staged = (context) => staged(erased(context, half, marks));

  if (closing !== undefined) {
    listening.closing = (context) => closing(erased(context, half, marks));
  }

  return listening;
}

export function engineExtension(half: ErasedHooks): EngineExtension {
  const marks: Marks = new WeakMap();
  const extension = { id: half.id, tools: toolsOf(half, marks), ...listeningOf(half, marks) };

  return half.refuses === undefined ? extension : { ...extension, refuses: half.refuses };
}
