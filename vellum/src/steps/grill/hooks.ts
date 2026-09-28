import type {
  HooksHalf,
  HooksTool,
  ToolAnswer,
  ToolCallContext,
} from "../../runtime/hooks/extension.ts";
import type { StepPlugs } from "../proposal/contract.ts";
import type { GrillPlugs, Waited } from "./contract.ts";
import { ANSWERS, ASK_TOOL, NO_GRILL_OPEN, parseQuestions } from "./parse.ts";

/** `step`'s tool, the one way to a grill: its name held to the step's contract, since a hooks half loads its own folder alone. */
const PROPOSE_TOOL: `mcp__vellum__${StepPlugs["hooks"]["tools"]}` = "mcp__vellum__propose";

const CLOSED_WITHOUT_SEND =
  "The round was closed from the page: what the reviewer sent arrives as a prompt. End your turn.";

/**
 * What the call returns once its round closes: the Send that closed it, under its entry's number;
 * a round closed without one says its answers come as a prompt.
 */
function settled(waited: Waited): ToolAnswer | null {
  switch (waited.kind) {
    case "open":
      return null;
    case "ended":
      return { result: CLOSED_WITHOUT_SEND };
    case "answered":
      return { result: waited.text, returns: waited.seq };
  }
}

/** Kept small on purpose: a tool's schema rides in every request. */
const ASK: HooksTool<ToolCallContext<GrillPlugs>> = {
  description:
    "Ask one round of the open grill of a vellum planning session, and wait: the reviewer answers in the review page, and their reply is this call's result. q: one [title, question, recommendation] per question; title is one line of plain text, question and recommendation are Markdown; the page numbers them across the whole grill. Refused outside vellum planning, and when no grill is open: only the reviewer opens one, from the next step you propose or on their own. While a grill is open you may still write plan.md: it waits, and a prompt tells you once the grill ends.",
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
    const posted = await context.post("POST ask", { q });

    if (posted.ok) {
      const { file, first } = posted.answer;

      // A wait that fails throws at once: what the round gets reaches Claude through the channel.
      return await context.waitFor({
        mark: file,
        route: "POST wait",
        body: { file, first },
        attempts: 1,
        settle: settled,
      });
    }

    if (posted.reason === NO_GRILL_OPEN) {
      return { deny: `${posted.reason}: propose one with ${PROPOSE_TOOL}` };
    }

    return { deny: posted.reason ?? `the review server answered ${posted.status}` };
  },
};

export const hooks: HooksHalf<GrillPlugs> = {
  id: "grill",
  tools: { grill_ask: ASK },
  answers: ANSWERS,
  // The page is the reviewer's one channel while live, so the terminal's question tool is closed.
  refuses: {
    AskUserQuestion: `vellum is live: propose the next step with ${PROPOSE_TOOL}, or ask inside an open grill with ${ASK_TOOL}`,
  },
  // A command of the session is the harness's, kept as an event; what the reviewer types in the
  // terminal is not the grill's. The server writes only while a grill is open.
  prompted: async (context, prompt) => {
    if (prompt.text.trimStart().startsWith("/")) {
      await context.post("POST event", { command: prompt.text });
    }
  },
  answered: async (context, turn) => {
    const asked = context.unanswered() !== undefined;
    await context.post("POST answer", { ...turn, asked });
  },
  closing: async (context) => {
    await context.post("POST close", { reason: "stop" });
  },
};
