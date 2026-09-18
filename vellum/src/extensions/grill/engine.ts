import type {
  EngineContext,
  EngineExtension,
  ExtensionTool,
  ToolAnswer,
} from "../../core/engine/extension.ts";
import {
  authorOf,
  parseAsked,
  parseError,
  parseJson,
  parseQuestions,
  parseRelay,
  parseRelayedRound,
  parseSuggestion,
  type Relay,
  type RelayedRound,
} from "./parse.ts";
import type { GrillPosts } from "./protocol.ts";

const ASK_TOOL = "mcp__vellum__grill_ask";

const SUGGEST_TOOL = "mcp__vellum__grill_suggest";

/** Claude holds every round in its context, and the transcript's path since the opening: the fact alone is news. */
const ENDED_PROMPT = "The reviewer ended the grill.";

/** Rounds count from 1, so 0 records that the end of the file's grill was told. */
const ENDED = 0;

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

const SUGGEST: ExtensionTool = {
  name: "grill_suggest",
  description:
    "Suggest a grill to the reviewer in the review page: the subject, and in one sentence why the choices need them. The reviewer starts it, or not.",
  inputSchema: {
    type: "object",
    properties: { subject: { type: "string" }, reason: { type: "string" } },
    required: ["subject", "reason"],
  },
  call: async (context, input): Promise<ToolAnswer> => {
    const suggestion = parseSuggestion(input);

    if (suggestion === null) return { deny: "subject and reason must both be non-empty strings" };
    const response = await post(context, "suggest", suggestion);

    if (response.ok) {
      return { result: "Suggested. End your turn; the reviewer opens the grill from the page." };
    }

    const error = parseError(parseJson(response.text));

    return {
      deny:
        response.status === 409 && error !== null
          ? `${error}: ask with ${ASK_TOOL}`
          : `the review server answered ${response.status}`,
    };
  },
};

/** Round 1 is the reviewer's gesture in the page, so Claude is told what it means; the next ones go as written. */
function relayPrompt(
  context: EngineContext,
  subject: string,
  reviewer: NonNullable<Extract<Relay, { kind: "open" }>["reviewer"]>,
): string {
  return reviewer.round === 1
    ? `The reviewer opened a grill in ${reviewer.file} on: ${subject}. Read ${context.host.pluginRoot}/src/extensions/grill/grilling.md, then ask the first round with ${ASK_TOOL}.`
    : reviewer.text;
}

/** What one poll has to tell Claude, and the record that says it was told. */
type News = { readonly told: RelayedRound; readonly prompt: string };

function newsOf(context: EngineContext, relay: Relay | null): News | null {
  if (relay === null) return null;

  if (relay.kind === "ended") {
    return { told: { file: relay.file, round: ENDED }, prompt: ENDED_PROMPT };
  }

  const { reviewer, subject } = relay;

  return reviewer === null
    ? null
    : {
        told: { file: reviewer.file, round: reviewer.round },
        prompt: relayPrompt(context, subject, reviewer),
      };
}

/**
 * Relays each round the reviewer wrote, once, then the end of a grill they closed from the page.
 * What was told is kept in `$.store`, and the rounds are on the server's disk: a reloaded module
 * or a restarted server repeats nothing.
 */
async function tick(context: EngineContext): Promise<void> {
  const { host, live, api } = context;
  const news = newsOf(context, parseRelay(parseJson((await api.get("state")).text)));

  if (news === null) return;
  const key = relayedKey(live.session.id);
  const relayed = parseRelayedRound(await host.storeGet(key));
  const { file, round } = news.told;

  if (relayed?.file === file && relayed.round === round) return;

  // An end is told only to the session that relayed a round of that grill: after a `/clear`,
  // an old transcript of the directory means nothing to the new context.
  if (round === ENDED && relayed?.file !== file) return;
  const result = await host.submitPrompt(news.prompt);

  if (result.drop !== undefined) {
    host.log(`the grill prompt was dropped: ${result.drop}`);

    return;
  }

  await host.storeSet(key, news.told);

  // The path is the harness's to show, never the model's to read again.
  if (round === ENDED) host.log(`grill closed from the page; ${file} is kept`);
}

export const grillEngine: EngineExtension = {
  id: "grill",
  tools: [SUGGEST, ASK],
  // The page is the reviewer's one channel while live, so the terminal's question tool is closed.
  refuses: {
    AskUserQuestion: `vellum is live: suggest a grill with ${SUGGEST_TOOL}, or ask inside an open grill with ${ASK_TOOL}`,
  },
  // Word for word: the server writes both only while a grill is open, so nothing is kept here.
  prompted: async (context, prompt) => {
    await post(context, "prompt", { author: authorOf(prompt.origin), text: prompt.text });
  },
  answered: async (context, turn) => {
    await post(context, "answer", turn);
  },
  tick,
  // The server writes the footer where the plan lives now: after an approval, the renamed directory.
  closing: async (context, reason) => {
    await post(context, "close", { reason });
  },
};
