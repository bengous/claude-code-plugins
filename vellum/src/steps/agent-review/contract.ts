import type { ReviewEvents } from "../../review/contract.ts";
/**
 * The agent review step: the reviewer asks a plan reviewer, a subagent, to judge the version
 * under review, and its verdict lands beside the plan. Other folders import this file and nothing
 * else of the folder. The hooks module and the page read it as types: its values, the
 * events and the rows, are the server's.
 */
import type { PlugsOf } from "../../workshop/plugs.ts";
import { defineSlice, get, heard, post } from "../../workshop/plugs.ts";
import { rows } from "../../workshop/rows.ts";
import { reviewed } from "../../workshop/workflow.ts";
import {
  answersARunNeverLaunched,
  aRunIsUnderWay,
  namesAnotherVersion,
  namesNoAgentToStop,
  namesNoAskedRun,
  namesNoRunUnderWay,
  noVersionUnderReview,
  runIn,
} from "./agent-review.ts";

// The wire: what crosses `/api/x/agent-review/*` between the hooks module, the server and the page.

/** A review asked from the page, numbered by the server: asked, then launched by the hooks module. */
export type Run =
  | { readonly kind: "requested"; readonly seq: number; readonly version: number }
  | {
      readonly kind: "running";
      readonly seq: number;
      readonly version: number;
      readonly agentId: string;
      readonly model: string;
    };

/** The last run that ended without a verdict, and why; `model` is `null` for one never launched. */
export type Failed = {
  readonly seq: number;
  readonly version: number;
  readonly model: string | null;
  readonly why: string;
};

/** An agent whose run was given up, to be stopped: it leaves the list once a stop is confirmed. */
export type Stopping = { readonly seq: number; readonly agentId: string };

/** What `GET state` answers: the run under way, the last one that failed, and the agents to stop. */
export type ReviewState = {
  readonly run: Run | null;
  readonly failed: Failed | null;
  readonly stopping: readonly Stopping[];
};

/** What `.review/reviews.json` keeps: the state, and the last number a run took. */
export type Reviews = ReviewState & { readonly seq: number };

/** What `POST ended` carries: the agent's final text, or why the run gave none. */
export type Outcome =
  | { readonly kind: "answer"; readonly text: string }
  | { readonly kind: "failed"; readonly why: string };

/** `POST request`: the version the reviewer asks a review of. */
export type ReviewAsked = { readonly version: number };

/** `POST launched`: the run the hooks module launched, its agent and the agent's model. */
export type Launched = { readonly seq: number; readonly agentId: string; readonly model: string };

/** `POST ended`: the run and how it ended. */
export type Ended = { readonly seq: number; readonly outcome: Outcome };

/** `POST forget` and `POST stopped`: a run by its number. */
export type RunNumber = { readonly seq: number };

/** What `POST request` answers: the number the run took. */
export type Requested = { readonly seq: number };

/** What `POST close` answers: every agent to stop, the closed run's included. */
export type Closed = { readonly stopping: readonly Stopping[] };

// The declaration: the events it owns, those it hears, and where each half plugs in.

export const SLICE = defineSlice({
  id: "agent-review",
  events: {
    requestReview: { by: ["reviewer"], carries: ["version"] },
    reviewLaunched: { by: ["engine"], carries: ["seq", "agentId", "model"] },
    /** A verdict carries its text and the file it lands in; a failure, why. */
    reviewDone: { by: ["engine"], carries: ["seq", "outcome", "why", "text", "file"] },
    reviewForgotten: { by: ["reviewer"], carries: ["seq"] },
    reviewClosed: { by: ["engine"], carries: [] },
    reviewStopped: { by: ["engine"], carries: ["seq"] },
  },
  /** The approval gives up the run under way. */
  hears: { approve: heard<ReviewEvents["approve"]>() },
  hooks: {
    listens: ["staged", "agentAnswered", "closing"],
    posts: ["POST launched", "POST ended", "POST close", "POST stopped"],
    gets: ["GET state"],
  },
  routes: {
    "GET state": get<ReviewState>(),
    "POST request": post<ReviewAsked, Requested>(),
    "POST launched": post<Launched, null>(),
    "POST ended": post<Ended, null>(),
    "POST forget": post<RunNumber, null>(),
    /** Refused once the plan is approved, and answers the agents to stop all the same (F7). */
    "POST close": post<Readonly<Record<string, never>>, Closed>(),
    /** The one way an agent leaves the list: its stop confirmed, never a later write. */
    "POST stopped": post<RunNumber, null>(),
  },
  page: ["actions", "notices"],
});

export type AgentReviewPlugs = PlugsOf<typeof SLICE>;

export type AgentReviewEvents = AgentReviewPlugs["events"];

export type AgentReviewHears = AgentReviewPlugs["hears"];

// What is refused, read top to bottom per event, with the status its route answers.

const NO_SUCH_RUN = "no such run";

const { refuse, whileHeld } = rows(SLICE);

/** Before the hold (P2); an approved plan is the core's own rule, in the same words. */
export const RULES = [
  refuse(
    "requestReview",
    "no-version",
    noVersionUnderReview,
    409,
    "no version is under review yet",
  ),
  refuse(
    "requestReview",
    "other-version",
    namesAnotherVersion,
    409,
    (w, input) => `v${reviewed(w)} is under review, not v${input.version}`,
  ),
  refuse(
    "requestReview",
    "running",
    aRunIsUnderWay,
    409,
    (w) => `a review of v${runIn(w).version} is running`,
  ),
  whileHeld("requestReview", 409, (hold) => hold),
  refuse("reviewLaunched", "no-such-run", namesNoAskedRun, 409, NO_SUCH_RUN),
  refuse("reviewDone", "no-such-run", namesNoRunUnderWay, 409, NO_SUCH_RUN),
  refuse(
    "reviewDone",
    "never-launched",
    answersARunNeverLaunched,
    409,
    "the run was never launched",
  ),
  refuse("reviewForgotten", "no-such-run", namesNoRunUnderWay, 409, NO_SUCH_RUN),
  refuse("reviewStopped", "no-such-run", namesNoAgentToStop, 409, NO_SUCH_RUN),
];
