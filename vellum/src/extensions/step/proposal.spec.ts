import { expect, test } from "bun:test";

import { parseWipDir } from "../../core/server/domain/paths.ts";
import type { RowKey } from "../../core/server/domain/rows.ts";
import { tablePart } from "../../core/server/domain/rows.ts";
import type {
  EventInput,
  Region,
  RuleVerdict,
  Workflow,
} from "../../core/server/domain/workflow.ts";
import { next, tableOf } from "../../core/server/domain/workflow.ts";
import { refusedNowWith, stateWith } from "../proof.ts";
import type { Proposal, StepAnswer } from "./contract.ts";
import { RULES } from "./contract.ts";
import { regionOf } from "./proposal.ts";
import { server } from "./server.ts";

const TABLE = tableOf([tablePart("step", server.workflow)]);

const DIR = parseWipDir("plans/2026-09-28/wip-9b1d0e22/");

if (!DIR.ok) throw new Error(DIR.error);

const WORKDIR = DIR.value;

const PLAN: Proposal = { reason: "The plan is next.", moves: [{ kind: "plan" }], recommended: 0 };

const MOCKUP: Proposal = {
  reason: "The screen is unsettled.",
  moves: [{ kind: "mockup", screen: "login" }],
  recommended: 0,
};

const GRILL_HOLDS: Region = {
  id: "grill",
  state: "open",
  holds: "grill 1 is open",
  wait: null,
  data: {},
};

/** The review with the proposal `waiting` for the reviewer, `null` for none, and `plan.md` there or not. */
function review(waiting: string | null, plan: "absent" | "pending", held = false): Workflow {
  const file = {
    pending: waiting === null ? null : { id: waiting, proposal: MOCKUP },
    answered: null,
    dropped: null,
  };

  return {
    workspace: { kind: "drafting", dir: WORKDIR, batches: 0 },
    planText: plan,
    regions: [regionOf(file), ...(held ? [GRILL_HOLDS] : [])],
  };
}

function judged(w: Workflow, event: string, input: EventInput): RuleVerdict {
  return next(w, TABLE, event, input, "engine").verdict;
}

function proposing(proposal: Proposal): EventInput {
  return { id: "p2", proposal: JSON.stringify(proposal) };
}

const WHY: StepAnswer = { kind: "own", text: "Why?" };

function answering(id: string): EventInput {
  return { id, answer: JSON.stringify(WHY), move: "own", subject: "", opened: "" };
}

const NO_SUCH: RuleVerdict = {
  kind: "refuse",
  rule: "no-such-proposal",
  reason: "no such proposal",
};

/** One test per row of `RULES`, titled by the row: a row without its test does not compile. */
const ROW_TESTS = {
  "propose: held": [
    "propose is refused while the review is held, in the hold's words, before any other row",
    () => {
      expect(judged(review(null, "pending", true), "propose", proposing(PLAN))).toEqual({
        kind: "refuse",
        rule: "held",
        reason: "grill 1 is open: no step is proposed until it ends",
      });
    },
  ],
  "propose: plan-over-plan": [
    "propose is refused once plan.md exists when a move is the plan, and passes with none or before plan.md",
    () => {
      expect(judged(review(null, "pending"), "propose", proposing(PLAN))).toEqual({
        kind: "refuse",
        rule: "plan-over-plan",
        reason: "plan.md exists: the plan step is done",
      });
      expect(judged(review(null, "pending"), "propose", proposing(MOCKUP)).kind).toBe("allow");
      expect(judged(review(null, "absent"), "propose", proposing(PLAN)).kind).toBe("allow");
    },
  ],
  "pause: no-such-proposal": [
    "pause is refused when no proposal waits, whatever it names, or another one does, and passes on the one waiting",
    () => {
      expect(judged(review(null, "absent"), "pause", { id: "p1" })).toEqual(NO_SUCH);
      expect(judged(review(null, "absent"), "pause", {})).toEqual(NO_SUCH);
      expect(judged(review("p1", "absent"), "pause", { id: "p2" })).toEqual(NO_SUCH);
      expect(judged(review("p1", "absent"), "pause", { id: "p1" }).kind).toBe("allow");
    },
  ],
  "answerProposal: held": [
    "an answer is refused while the review is held, the hold its reason",
    () => {
      expect(judged(review("p1", "absent", true), "answerProposal", answering("p1"))).toEqual({
        kind: "refuse",
        rule: "held",
        reason: "grill 1 is open",
      });
    },
  ],
  "answerProposal: no-such-proposal": [
    "an answer naming a proposal is refused when another one waits or none does; the window opened blank passes",
    () => {
      expect(judged(review("p1", "absent"), "answerProposal", answering("p2"))).toEqual(NO_SUCH);
      expect(judged(review(null, "absent"), "answerProposal", answering("p1"))).toEqual(NO_SUCH);
      expect(judged(review("p1", "absent"), "answerProposal", answering("")).kind).toBe("allow");
      expect(judged(review("p1", "absent"), "answerProposal", answering("p1")).kind).toBe("allow");
    },
  ],
} satisfies { readonly [Row in RowKey<(typeof RULES)[number]>]: readonly [string, () => void] };

for (const [title, run] of Object.values(ROW_TESTS)) test(title, run);

// A row built on a `naming` guard refuses the input, never the state: what is refused now leaves it out.

test("a pause of a proposal a newer one replaced is refused for that input alone: refusedNow does not list pause", () => {
  expect(judged(review("p2", "absent"), "pause", { id: "p1" })).toEqual(NO_SUCH);
  expect(refusedNowWith(review("p2", "absent"), "pause", { id: "p1" })).toEqual([]);
});

test("a stale tab's answer to a proposal no longer waiting is refused for it alone: mcp__vellum__state does not list answerProposal", () => {
  expect(judged(review("p2", "absent"), "answerProposal", answering("p1"))).toEqual(NO_SUCH);
  expect(stateWith(review("p2", "absent"), "answerProposal", answering("p1"))).toEqual([]);
});
