import type {
  EngineContext,
  EngineExtension,
  ErasedContext,
  ErasedHooks,
  ExtensionTool,
  Listen,
  Listeners,
} from "./extension.ts";

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

function erased(context: EngineContext): ErasedContext {
  return {
    host: context.host,
    live: context.live,
    post: (route, body) => context.api.post(nameOf(route), JSON.stringify(body)),
  };
}

function toolsOf(half: ErasedHooks): readonly ExtensionTool[] {
  return Object.entries(half.tools).map(([name, tool]) => ({
    ...tool,
    name,
    call: (context, input) => tool.call({ ...erased(context), waiting: context.waiting }, input),
  }));
}

/** The listeners the half declares, each set only when present. */
function listeningOf(half: ErasedHooks): Listening {
  const listening: Listening = {};
  const { prompted, answered, agentAnswered, staged, closing } = half;

  if (prompted !== undefined) {
    listening.prompted = (context, prompt) => prompted(erased(context), prompt);
  }

  if (answered !== undefined) {
    listening.answered = (context, turn) => answered(erased(context), turn);
  }

  if (agentAnswered !== undefined) {
    listening.agentAnswered = (context, turn) => agentAnswered(erased(context), turn);
  }

  if (staged !== undefined) listening.staged = (context) => staged(erased(context));

  if (closing !== undefined) listening.closing = (context) => closing(erased(context));

  return listening;
}

export function engineExtension(half: ErasedHooks): EngineExtension {
  return { id: half.id, tools: toolsOf(half), ...listeningOf(half) };
}
