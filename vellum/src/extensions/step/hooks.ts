import type {
  HooksHalf,
  HooksTool,
  ToolAnswer,
  ToolCallContext,
} from "../../core/engine/extension.ts";
import type { Dropped, StepPlugs, StepWaited } from "./contract.ts";
import { ANSWERS, parseProposal } from "./parse.ts";

const GONE = "The review server restarted and lost this proposal: propose again.";

const APPROVED = "The reviewer approved the plan: no step follows. End your turn.";

const REPLACED = "A newer proposal replaced this one; its answer goes to that call.";

const WRITTEN = "plan.md was written: the plan step is done. Propose again if a step remains.";

/** What the call returns once its wait ends: the pick, a proposal the restarted server lost, or one dropped unanswered. */
function settled(waited: StepWaited): ToolAnswer | null {
  switch (waited.kind) {
    case "open":
      return null;
    case "answered":
      return { result: waited.text, returns: waited.seq };
    case "gone":
      return { deny: GONE };
    case "ended":
      return ended(waited.why);
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
const PROPOSE: HooksTool<ToolCallContext<StepPlugs>> = {
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
  awaits: "own",
  call: async (context, input): Promise<ToolAnswer> => {
    const proposal = parseProposal(input);

    if (proposal === null) {
      return {
        deny: "reason, moves and recommended: a non-empty reason, one move at least, each a grill with a subject, a mockup with a screen, a prototype with a question, each on one line, or the plan, and recommended the index of one of them",
      };
    }

    const posted = await context.post("POST propose", proposal);

    if (posted.ok) {
      const { id } = posted.answer;

      // After a crash the second post usually reaches the revived server, whose `gone` says to propose again.
      return await context.waitFor({
        mark: id,
        route: "POST wait",
        body: { id },
        attempts: 2,
        settle: settled,
      });
    }

    return { deny: posted.reason ?? `the review server answered ${posted.status}` };
  },
};

export const hooks: HooksHalf<StepPlugs> = {
  id: "step",
  tools: { propose: PROPOSE },
  answers: ANSWERS,
  // At the turn's end, never from the call Escape cut: every `$` of that call fails after Escape.
  answered: async (context, turn) => {
    const id = context.unanswered();

    if (id !== undefined && turn.reason === "aborted") await context.post("POST pause", { id });
  },
};
