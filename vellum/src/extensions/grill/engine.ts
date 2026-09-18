import type {
  EngineContext,
  EngineExtension,
  ExtensionTool,
  ToolAnswer,
} from "../../core/engine/extension.ts";
import type { Live } from "../../core/engine/mode.ts";
import {
  NO_GRILL_OPEN,
  type Cursor,
  parseAsked,
  parseCursor,
  parseError,
  parseJson,
  parsePolled,
  parseQuestions,
  parseSuggestion,
} from "./parse.ts";
import type { GrillPosts, Relay } from "./protocol.ts";

const ASK_TOOL = "mcp__vellum__grill_ask";

const SUGGEST_TOOL = "mcp__vellum__grill_suggest";

/** What the person at the terminal must know, and the agent must not read: a prompt typed there is not the grill's. */
const STATUS_OPEN = "grill open, answer in the page";

const STATUS_PLANNING = "planning";

const NO_CURSOR: Cursor = { file: "", seq: -1, taught: false };

/**
 * The modes whose status line says a grill is open. Keyed by the mode's own `Live`, so a reload
 * or a new way in, which both reset the line to `planning`, say it again.
 */
const statusShown = new WeakSet<Live>();

function cursorKey(sessionId: string): string {
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

    const error = parseError(parseJson(response.text));

    if (error === NO_GRILL_OPEN) return { deny: `no grill open: suggest one with ${SUGGEST_TOOL}` };

    return { deny: error ?? `the review server answered ${response.status}` };
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

/**
 * A prompt names its object and repeats nothing Claude wrote or read: the guide is named at the
 * first grill of a session alone, and a reply goes as the server worded it, under `Reviewer:`.
 */
function promptOf(context: EngineContext, relay: Relay, taught: boolean): string {
  if (relay.kind === "reply") return relay.text;

  if (relay.kind === "ended") return `The reviewer ended ${relay.name}.`;
  const opened = `The reviewer opened ${relay.name} on: ${relay.subject}.`;

  return taught
    ? opened
    : `${opened} Read ${context.host.pluginRoot}/src/extensions/grill/grilling.md, then ask with ${ASK_TOOL}.`;
}

function showStatus({ host, live }: EngineContext, open: boolean): void {
  if (open === statusShown.has(live)) return;
  host.status(open ? STATUS_OPEN : STATUS_PLANNING);

  if (open) statusShown.add(live);
  else statusShown.delete(live);
}

/**
 * Submits every entry past the cursor, one by one and in order, the cursor written after each:
 * a dropped prompt stops there and the next poll retries it. The entries are on the server's
 * disk and the cursor in `$.store`, so a reloaded module or a revived server repeats nothing.
 */
async function tick(context: EngineContext): Promise<void> {
  const { host, live, api } = context;
  const key = cursorKey(live.session.id);
  let cursor = parseCursor(await host.storeGet(key)) ?? NO_CURSOR;
  const query = `after=${cursor.seq}&file=${encodeURIComponent(cursor.file)}`;
  const polled = parsePolled(parseJson((await api.get(`state?${query}`)).text));

  if (polled === null) return;
  showStatus(context, polled.open);

  // A closed grill this session relayed nothing of: after a `/clear`, an old transcript of the
  // directory means nothing to the new context.
  if (!polled.open && polled.relays[0]?.kind === "opened") return;

  for (const relay of polled.relays) {
    const result = await host.submitPrompt(promptOf(context, relay, cursor.taught));

    if (result.drop !== undefined) {
      host.log(`the grill prompt was dropped: ${result.drop}`);

      return;
    }

    cursor = {
      file: relay.kind === "reply" ? cursor.file : relay.name,
      seq: relay.seq,
      taught: cursor.taught || relay.kind === "opened",
    };

    await host.storeSet(key, cursor);

    // The path is the harness's to show, never the model's to read again.
    if (relay.kind === "ended") host.log(`grill closed from the page; ${relay.name} is kept`);
  }
}

export const grillEngine: EngineExtension = {
  id: "grill",
  tools: [SUGGEST, ASK],
  // The page is the reviewer's one channel while live, so the terminal's question tool is closed.
  refuses: {
    AskUserQuestion: `vellum is live: suggest a grill with ${SUGGEST_TOOL}, or ask inside an open grill with ${ASK_TOOL}`,
  },
  // A command of the session is the harness's, kept as an event; what the reviewer types in the
  // terminal is not the grill's. The server writes only while a grill is open.
  prompted: async (context, prompt) => {
    if (prompt.text.trimStart().startsWith("/")) {
      await post(context, "event", { command: prompt.text });
    }
  },
  answered: async (context, turn) => {
    await post(context, "answer", turn);
  },
  tick,
  closing: async (context) => {
    await post(context, "close", { reason: "stop" });
  },
};
