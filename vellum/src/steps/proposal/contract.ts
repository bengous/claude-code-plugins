import type { ReviewEvents } from "../../review/contract.ts";
import type { PlugsOf } from "../../workshop/plugs.ts";
import { defineSlice, get, heard, post } from "../../workshop/plugs.ts";
import { allOf, anyOf, rows } from "../../workshop/rows.ts";
import { planExists } from "../../workshop/workflow.ts";
import { namesAnotherProposal, namesAProposal, noProposalWaits, offersPlan } from "./proposal.ts";

/**
 * The proposal step: Claude proposes the next steps, one recommended, and the reviewer picks one.
 * Other folders import this file and nothing else of the folder. The hooks module and the page
 * read it as types: its values, the events and the rows, are the server's.
 */

// The wire: what crosses `/api/x/proposal/*` between the hooks module, the server and the page.

/** A step Claude may take next; for a grill, `choices` are the titles of the choices it would settle. */
export type Move =
  | { readonly kind: "grill"; readonly subject: string; readonly choices: readonly string[] }
  | { readonly kind: "mockup"; readonly screen: string }
  | { readonly kind: "prototype"; readonly question: string }
  | { readonly kind: "plan" };

/** Why a step is needed now, the moves offered, and the index of the one Claude would take. */
export type Proposal = {
  readonly reason: string;
  readonly moves: readonly Move[];
  readonly recommended: number;
};

/** The reviewer's answer: a move, one of the proposal's or one of their own, or their own words. */
export type StepAnswer =
  | { readonly kind: "move"; readonly move: Move }
  | { readonly kind: "own"; readonly text: string };

/** The proposal waiting for the reviewer, under the id the server gave it. */
export type Pending = { readonly id: string; readonly proposal: Proposal };

/** The proposal waiting, if any, and whether Claude's call stopped waiting on it (Escape, a restart), so the pick reaches Claude as a message. */
export type StepState = { readonly pending: Pending | null; readonly paused: boolean };

/** The id a proposal waits under. */
export type ProposalId = { readonly id: string };

/** The id `POST propose` gave. */
export type Proposed = ProposalId;

/** The proposal's wait, paused. */
export type Paused = { readonly wait: "paused" };

/** The proposal the window showed, `null` for the window opened blank, and the reviewer's answer. */
export type AnswerBody = { readonly id: string | null; readonly answer: StepAnswer };

/** Why a proposal stopped waiting unanswered: a newer one, the approval, or `plan.md` written while the plan was its one move. */
export type Dropped = "replaced" | "approved" | "written";

/** The answer, its entry's number and the text `propose` returns; the proposal dropped, and why; an id the server does not know; or still waiting once the hold ran out. */
export type StepWaited =
  | { readonly kind: "answered"; readonly seq: number; readonly text: string }
  | { readonly kind: "ended"; readonly why: Dropped }
  | { readonly kind: "gone" }
  | { readonly kind: "open" };

// The declaration: the events it owns, those it hears, and where each half plugs in.

export const SLICE = defineSlice({
  id: "proposal",
  events: {
    propose: { by: ["claude"], carries: ["id", "proposal"] },
    wait: { by: ["engine"], carries: ["id"] },
    pause: { by: ["engine"], carries: ["id"] },
    answerProposal: { by: ["reviewer"], carries: ["id", "answer", "move", "subject", "opened"] },
  },
  /** The approval ends the proposal waiting; `plan.md` written takes the plan step out of it. */
  hears: {
    approve: heard<ReviewEvents["approve"]>(),
    planWritten: heard<ReviewEvents["planWritten"]>(),
    sendEdit: heard<ReviewEvents["sendEdit"]>(),
  },
  hooks: {
    tools: ["propose"],
    listens: ["answered"],
    posts: ["POST propose", "POST wait", "POST pause"],
  },
  routes: {
    "GET state": get<StepState>(),
    "POST propose": post<Proposal, Proposed>(),
    /** Held until the proposal is answered or gone, or for the hold at most. */
    "POST wait": post<ProposalId, StepWaited>(),
    /** Claude's turn was cut while its call waited: posted at the turn's end. */
    "POST pause": post<ProposalId, Paused>(),
    "POST answer": post<AnswerBody, null>(),
  },
  page: ["actions", "notices"],
});

export type ProposalPlugs = PlugsOf<typeof SLICE>;

export type ProposalEvents = ProposalPlugs["events"];

export type ProposalHears = ProposalPlugs["hears"];

// What is refused, read top to bottom per event, with the status its route answers.

const NO_SUCH_PROPOSAL = "no such proposal";

const { refuse, whileHeld } = rows(SLICE);

export const RULES = [
  whileHeld("propose", 409, (hold) => `${hold}: no step is proposed until it ends`),
  refuse(
    "propose",
    "plan-over-plan",
    allOf(planExists, offersPlan),
    409,
    "plan.md exists: the plan step is done",
  ),
  refuse(
    "pause",
    "no-such-proposal",
    anyOf(noProposalWaits, namesAnotherProposal),
    404,
    NO_SUCH_PROPOSAL,
  ),
  whileHeld("answerProposal", 409, (hold) => hold),
  refuse(
    "answerProposal",
    "no-such-proposal",
    allOf(namesAProposal, namesAnotherProposal),
    409,
    NO_SUCH_PROPOSAL,
  ),
];
