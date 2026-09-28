import type {
  HooksContext,
  HooksHalf,
  HooksTool,
  ToolAnswer,
} from "../../core/engine/extension.ts";
import type { Live } from "../../core/engine/mode.ts";
import type { Dropped, StepPlugs, StepWaited } from "./contract.ts";
import { parseError, parseJson, parseProposal, parseProposed, parseWaited } from "./parse.ts";

type Context = HooksContext<StepPlugs>;

/** The proposal the running turn's call waited on and heard nothing back for, by mode: a turn cut short pauses it. */
const waitedOn = new WeakMap<Live, string>();

const GONE = "The review server restarted and lost this proposal: propose again.";

const APPROVED = "The reviewer approved the plan: no step follows. End your turn.";

const REPLACED = "A newer proposal replaced this one; its answer goes to that call.";

const WRITTEN = "plan.md was written: the plan step is done. Propose again if a step remains.";

/**
 * One `POST wait`, asked once more at once when it fails, with no pause, so a `$` call is always
 * in flight: after a crash the second one usually reaches the revived server, which answers
 * `gone`. Two failures throw, and the core's `.catch` answers that the pick comes as a prompt.
 */
async function waited(context: Context, id: string): Promise<StepWaited> {
  for (let tries = 1; ; tries += 1) {
    const response = await context.post("POST wait", { id }).catch(() => null);
    const read = response?.ok === true ? parseWaited(parseJson(response.text)) : null;

    if (read !== null) return read;

    if (tries === 2) {
      throw new Error(`POST wait failed twice: ${response?.status ?? "no answer"}`);
    }
  }
}

/**
 * Holds the call until the reviewer answers, one `POST wait` in flight at a time: the engine cuts
 * each at 30 s and counts no hook time while one is out (`docs/plugin-testing/hook-runtime.md`).
 */
async function waitFor(context: Context, id: string): Promise<ToolAnswer> {
  for (;;) {
    const read = await waited(context, id);

    if (read.kind === "open") continue;
    waitedOn.delete(context.live);

    if (read.kind === "answered") return { result: read.text, returns: read.seq };

    return read.kind === "gone" ? { deny: GONE } : ended(read.why);
  }
}

/** A proposal dropped unanswered: the approval ends the step, a newer one takes the answer, `plan.md` written ends the plan step. */
function ended(why: Dropped): ToolAnswer {
  switch (why) {
    case "approved":
      return { result: APPROVED };
    case "replaced":
      return { deny: REPLACED };
    case "written":
      return { result: WRITTEN };
  }
}

/** Kept small on purpose: a tool's schema rides in every request. */
const PROPOSE: HooksTool<Context> = {
  description:
    'Propose the next step to the reviewer of a vellum planning session, and wait: the reviewer picks one in the review page, and their pick is this call\'s result: "Accepted: <move>." for the one you recommended, "Chose: <move>." for another, "Own: <text>." for their own words. reason: one sentence, why a step is needed now. moves: {kind: "grill", subject, choices} (choices: the titles of the open choices it settles), {kind: "mockup", screen}, {kind: "prototype", question} or {kind: "plan"}; subject, screen and question on one line. recommended: the index of the move you would take. Refused outside vellum planning, while the review is held (a grill, a plan review), and when a move is the plan once plan.md exists: the plan step is done.',
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
  // A proposal is answered by the reviewer's pick, one entry of this slice's, which the call returns.
  awaits: (entry) => entry.kind === "text" && entry.from === "step",
  call: async (context, input): Promise<ToolAnswer> => {
    const proposal = parseProposal(input);

    if (proposal === null) {
      return {
        deny: "reason, moves and recommended: a non-empty reason, one move at least, each a grill with a subject, a mockup with a screen, a prototype with a question, each on one line, or the plan, and recommended the index of one of them",
      };
    }

    const response = await context.post("POST propose", proposal);
    const proposed = response.ok ? parseProposed(parseJson(response.text)) : null;

    if (proposed !== null) {
      waitedOn.set(context.live, proposed.id);
      context.waiting();

      return await waitFor(context, proposed.id);
    }

    const error = parseError(parseJson(response.text));

    return { deny: error ?? `the review server answered ${response.status}` };
  },
};

export const hooks: HooksHalf<StepPlugs> = {
  id: "step",
  tools: { propose: PROPOSE },
  // At the turn's end, never from the call Escape cut: every `$` of that call fails after Escape.
  answered: async (context, turn) => {
    const id = waitedOn.get(context.live);
    waitedOn.delete(context.live);

    if (id !== undefined && turn.reason === "aborted") await context.post("POST pause", { id });
  },
};
