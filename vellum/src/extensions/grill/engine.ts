import type {
  EngineContext,
  EngineExtension,
  ExtensionTool,
  ToolAnswer,
} from "../../core/engine/extension.ts";
import {
  parseAsked,
  parseError,
  parseJson,
  parseQuestions,
  parseRelay,
  parseRelayedRound,
  type Relay,
  type RelayedRound,
} from "./parse.ts";
import type { GrillPosts } from "./protocol.ts";

const ASK_TOOL = "mcp__vellum__grill_ask";

const SUGGEST_TOOL = "mcp__vellum__grill_suggest";

function relayedKey(sessionId: string): string {
  return `grill:${sessionId}`;
}

function post<Name extends keyof GrillPosts>(
  context: EngineContext,
  name: Name,
  body: GrillPosts[Name],
): ReturnType<EngineContext["api"]["post"]> {
  return context.api.post(name, JSON.stringify(body));
}

/** Kept small on purpose: a tool's schema rides in every request. */
const ASK: ExtensionTool = {
  name: "grill_ask",
  description:
    "Ask one round of the open grill in the review page. q: one [title, question, recommendation] per question; the page numbers them.",
  inputSchema: {
    type: "object",
    properties: {
      q: {
        type: "array",
        items: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 3 },
      },
    },
    required: ["q"],
  },
  call: async (context, input): Promise<ToolAnswer> => {
    const questions = parseQuestions(input);

    if (questions === null) {
      return { deny: "q must be a non-empty array of [title, question, recommendation]" };
    }

    const q = questions.map(({ title, ask, rec }) => [title, ask, rec] as const);
    const response = await post(context, "ask", { q });
    const asked = response.ok ? parseAsked(parseJson(response.text)) : null;

    if (asked !== null) {
      return {
        result: `Asked Q${asked.first}–Q${asked.last}, in order. End your turn in one short line; answers arrive as "Qn: ..." lines.`,
      };
    }

    return {
      deny:
        response.status === 409
          ? `no grill open: suggest one with ${SUGGEST_TOOL}`
          : (parseError(parseJson(response.text)) ??
            `the review server answered ${response.status}`),
    };
  },
};

/** Round 1 is the reviewer's gesture in the page, so Claude is told what it means; the next ones go as written. */
function relayPrompt(
  context: EngineContext,
  subject: string,
  reviewer: NonNullable<Relay["reviewer"]>,
): string {
  return reviewer.round === 1
    ? `The reviewer opened a grill in ${reviewer.file} on: ${subject}. Read ${context.host.pluginRoot}/src/extensions/grill/grilling.md, then ask the first round with ${ASK_TOOL}.`
    : reviewer.text;
}

/**
 * Relays each round the reviewer wrote, once. The round already relayed is kept in `$.store`, and
 * the rounds are on the server's disk: a reloaded module or a restarted server repeats none.
 */
async function tick(context: EngineContext): Promise<void> {
  const { host, live, api } = context;
  const relay = parseRelay(parseJson((await api.get("state")).text));

  if (relay === null || relay.reviewer === null) return;
  const { file, round } = relay.reviewer;
  const key = relayedKey(live.session.id);
  const relayed = parseRelayedRound(await host.storeGet(key));

  if (relayed?.file === file && relayed.round === round) return;
  const result = await host.submitPrompt(relayPrompt(context, relay.subject, relay.reviewer));

  if (result.drop !== undefined) {
    host.log(`the grill round was dropped: ${result.drop}`);

    return;
  }

  const next: RelayedRound = { file, round };
  await host.storeSet(key, next);
}

export const grillEngine: EngineExtension = {
  id: "grill",
  tools: [ASK],
  tick,
};
