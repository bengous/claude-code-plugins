import type {
  EngineContext,
  EngineExtension,
  ExtensionTool,
  ToolAnswer,
  ToolContext,
} from "../../core/engine/extension.ts";
import type { Live } from "../../core/engine/mode.ts";
import {
  NO_GRILL_OPEN,
  parseAsked,
  parseError,
  parseIsOpen,
  parseJson,
  parseQuestions,
  parseWaited,
} from "./parse.ts";
import { ASK_TOOL, type GrillPosts } from "./protocol.ts";

/** `step`'s tool, the one way to a grill: named, never imported, since an extension loads its own folder alone. */
const PROPOSE_TOOL = "mcp__vellum__propose";

/** What the person at the terminal must know, and the agent must not read: a prompt typed there is not the grill's. */
const SEGMENT_OPEN = "grill · open";

/** The modes whose last read found a grill open, keyed by the mode's own `Live`: a new way in starts with none. */
const grillOpen = new WeakSet<Live>();

/** The modes whose running turn asked a round no answer came back to: its text goes with that round, before a reply sent meanwhile. */
const askedIn = new WeakSet<Live>();

/** The modes whose running turn got a round's answer as the tool's result: its text answers the reviewer. */
const repliedIn = new WeakSet<Live>();

const CLOSED_WITHOUT_SEND =
  "The round was closed from the page: what the reviewer sent arrives as a prompt. End your turn.";

function post<Name extends keyof GrillPosts>(
  context: EngineContext,
  name: Name,
  body: GrillPosts[Name],
): ReturnType<EngineContext["api"]["post"]> {
  return context.api.post(name, JSON.stringify(body));
}

/**
 * Holds the call until the round closes, one `POST wait` in flight at a time: the engine cuts
 * each at 30 s and counts no hook time while one is out (`docs/plugin-testing/hook-runtime.md`).
 * A Send that closes the round comes back as the result, under its entry's number; a round
 * closed without one comes back as a prompt. A wait that fails throws: the core's `.catch`
 * answers Claude, and what the round gets reaches it through the channel.
 */
async function waitFor(context: ToolContext, file: string, first: number): Promise<ToolAnswer> {
  for (;;) {
    const response = await post(context, "wait", { file, first });
    const waited = response.ok ? parseWaited(parseJson(response.text)) : null;

    if (waited === null) {
      throw new Error(`POST wait answered ${response.status}: ${response.text.slice(0, 200)}`);
    }

    if (waited.kind === "open") continue;
    askedIn.delete(context.live);

    if (waited.kind === "ended") return { result: CLOSED_WITHOUT_SEND };
    repliedIn.add(context.live);

    return { result: waited.text, returns: waited.seq };
  }
}

/** Kept small on purpose: a tool's schema rides in every request. */
const ASK: ExtensionTool = {
  name: "grill_ask",
  description:
    "Ask one round of the open grill of a vellum planning session, and wait: the reviewer answers in the review page, and their reply is this call's result. q: one [title, question, recommendation] per question; title is one line of plain text, question and recommendation are Markdown; the page numbers them across the whole grill. Refused outside vellum planning, and when no grill is open: only the reviewer opens one, from the next step you propose or on their own.",
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
  // A round is answered by the reviewer's Send, one batch, which the call returns.
  awaits: (entry) => entry.kind === "sent",
  call: async (context, input): Promise<ToolAnswer> => {
    const questions = parseQuestions(input);

    if (questions === null) {
      return {
        deny: "q must be a non-empty array of [title, question, recommendation], each title one line of plain text: not empty, no **, not ending in *, and each question with a recommendation",
      };
    }

    const q = questions.map(({ title, ask, rec }) => [title, ask, rec] as const);
    const response = await post(context, "ask", { q });
    const asked = response.ok ? parseAsked(parseJson(response.text)) : null;

    if (asked !== null) {
      askedIn.add(context.live);
      context.waiting();

      return await waitFor(context, asked.file, asked.first);
    }

    const error = parseError(parseJson(response.text));

    if (error === NO_GRILL_OPEN) return { deny: `no grill open: propose one with ${PROPOSE_TOOL}` };

    return { deny: error ?? `the review server answered ${response.status}` };
  },
};

/** Whether a grill is open, read again each time the review changed: the band says so. */
async function staged({ live, api }: EngineContext): Promise<void> {
  const open = parseIsOpen(parseJson((await api.get("state")).text));

  if (open === null) return;

  if (open) grillOpen.add(live);
  else grillOpen.delete(live);
}

export const grillEngine: EngineExtension = {
  id: "grill",
  tools: [ASK],
  // The page is the reviewer's one channel while live, so the terminal's question tool is closed.
  refuses: {
    AskUserQuestion: `vellum is live: propose the next step with ${PROPOSE_TOOL}, or ask inside an open grill with ${ASK_TOOL}`,
  },
  // A command of the session is the harness's, kept as an event; what the reviewer types in the
  // terminal is not the grill's. The server writes only while a grill is open.
  prompted: async (context, prompt) => {
    if (prompt.text.trimStart().startsWith("/")) {
      await post(context, "event", { command: prompt.text });
    }
  },
  answered: async (context, turn) => {
    const asked = askedIn.delete(context.live);
    const own = repliedIn.delete(context.live) || turn.own;
    await post(context, "answer", { ...turn, own, asked });
  },
  staged,
  segment: ({ live }) => (grillOpen.has(live) ? SEGMENT_OPEN : null),
  closing: async (context) => {
    await post(context, "close", { reason: "stop" });
  },
};
