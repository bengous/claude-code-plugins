import type {
  EngineContext,
  EngineExtension,
  ExtensionTool,
  ToolAnswer,
  ToolContext,
} from "../../core/engine/extension.ts";
import { parseError, parseJson, parseProposal, parseProposed, parseWaited } from "./parse.ts";
import type { StepPosts } from "./protocol.ts";

const LOST =
  "The proposal no longer waits for the reviewer: the review server restarted, or the review moved on. Propose again.";

function post<Name extends keyof StepPosts>(
  context: EngineContext,
  name: Name,
  body: StepPosts[Name],
): ReturnType<EngineContext["api"]["post"]> {
  return context.api.post(name, JSON.stringify(body));
}

/**
 * Holds the call until the reviewer answers, one `POST wait` in flight at a time: the engine cuts
 * each at 30 s and counts no hook time while one is out (`docs/plugin-testing/hook-runtime.md`).
 * The proposal lives in the server's memory alone, so a wait that fails, or finds it gone, tells
 * Claude to propose again: no answer to it will ever come.
 */
async function waitFor(context: ToolContext, id: string): Promise<ToolAnswer> {
  for (;;) {
    const response = await post(context, "wait", { id }).catch(() => null);
    const waited = response?.ok === true ? parseWaited(parseJson(response.text)) : null;

    if (waited === null || waited.kind === "gone") return { deny: LOST };

    if (waited.kind === "answered") return { result: waited.text, returns: waited.seq };
  }
}

/** Kept small on purpose: a tool's schema rides in every request. */
const PROPOSE: ExtensionTool = {
  name: "propose",
  description:
    'Propose the next step to the reviewer of a vellum planning session, and wait: the reviewer picks one in the review page, and their pick is this call\'s result: "Accepted: <move>." for the one you recommended, "Chose: <move>." for another, "Own: <text>." for their own words. reason: one sentence, why a step is needed now. moves: {kind: "grill", subject, choices} (choices: the titles of the open choices it settles), {kind: "mockup", screen}, {kind: "prototype", question} or {kind: "plan"}; subject, screen and question on one line. recommended: the index of the move you would take. Refused outside vellum planning, and while a grill is open.',
  inputSchema: {
    type: "object",
    properties: {
      reason: { type: "string" },
      moves: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            kind: { enum: ["grill", "mockup", "prototype", "plan"] },
            subject: { type: "string" },
            choices: { type: "array", items: { type: "string" } },
            screen: { type: "string" },
            question: { type: "string" },
          },
          required: ["kind"],
        },
      },
      recommended: { type: "integer", minimum: 0 },
    },
    required: ["reason", "moves", "recommended"],
  },
  // A proposal is answered by the reviewer's pick, one entry of this extension's, which the call returns.
  awaits: (entry) => entry.kind === "text" && entry.from === "step",
  call: async (context, input): Promise<ToolAnswer> => {
    const proposal = parseProposal(input);

    if (proposal === null) {
      return {
        deny: "reason, moves and recommended: a non-empty reason, one move at least, each a grill with a subject, a mockup with a screen, a prototype with a question, each on one line, or the plan, and recommended the index of one of them",
      };
    }

    const response = await post(context, "propose", proposal);
    const proposed = response.ok ? parseProposed(parseJson(response.text)) : null;

    if (proposed !== null) {
      context.waiting();

      return await waitFor(context, proposed.id);
    }

    const error = parseError(parseJson(response.text));

    return { deny: error ?? `the review server answered ${response.status}` };
  },
};

export const stepEngine: EngineExtension = { id: "step", tools: [PROPOSE] };
