import type {
  Carried,
  EndsWithoutVerdict,
  Reactions,
  Samples,
  Transitions,
} from "../../workshop/rows.ts";
import { naming } from "../../workshop/rows.ts";
import type { Effect, Outcome, Region, Workflow } from "../../workshop/workflow.ts";
import { regionIn, SAMPLE_AT, unchanged, withRegion } from "../../workshop/workflow.ts";
import { REVIEW_DIR } from "../../workshop/workspace.ts";
import type {
  AgentReviewEvents,
  AgentReviewHears,
  AgentReviewPlugs,
  Reviews,
  Run,
} from "./contract.ts";
import { parseJson, parseReviews, REVIEWER } from "./parse.ts";

/**
 * The agent review's part of the workflow: the runs of `.review/reviews.json`. A run under way,
 * from its request to its end, holds the review, its number part of the reason the approval's
 * warning compares; the numbering and the agents to stop outlive it.
 */

export const AGENT_REVIEW: AgentReviewPlugs["id"] = "agent-review";

export const REVIEWS_FILE = `${REVIEW_DIR}/reviews.json`;

/** No run yet, and none ever asked. */
export const NO_RUNS: Reviews = { seq: 0, run: null, failed: null, stopping: [] };

/** Open while a run is asked or running. */
export function regionOf(reviews: Reviews | null): Region {
  const { seq, run, failed, stopping } = reviews ?? NO_RUNS;
  // One order of the fields, whoever wrote the file: the data is compared as a text.
  const data = { reviews: JSON.stringify({ seq, run, failed, stopping }) };

  return run === null
    ? { id: AGENT_REVIEW, state: "closed", data }
    : {
        id: AGENT_REVIEW,
        state: "open",
        holds: `plan review ${run.seq} of v${run.version} is running`,
        wait: null,
        data,
      };
}

/** The runs this module serialized itself: runs it cannot read back are a bug, never a state. */
export function reviewsOf(region: Region): Reviews {
  const text = String(region.data.reviews ?? "");
  const reviews = parseReviews(parseJson(text));

  if (reviews === null) throw new Error(`not the runs: ${text}`);

  return reviews;
}

function reviewsIn(w: Workflow): Reviews {
  return reviewsOf(regionIn(w, AGENT_REVIEW));
}

/** The run a row found under way. */
export function runIn(w: Workflow): Run {
  const { run } = reviewsIn(w);

  if (run === null) throw new Error("no run is under way");

  return run;
}

function seqOf(input: { readonly seq: string }): number {
  return Number(input.seq);
}

// The guards the rows of `contract.ts` are built from, each stating the fields it reads.

export const noVersionUnderReview = (w: Workflow): boolean => w.workspace.kind === "drafting";

export const aRunIsUnderWay = (w: Workflow): boolean => reviewsIn(w).run !== null;

export const {
  namesAnotherVersion,
  namesNoAskedRun,
  namesNoRunUnderWay,
  answersARunNeverLaunched,
  namesNoAgentToStop,
} = naming({
  namesAnotherVersion: (w: Workflow, input: { readonly version: string }): boolean =>
    w.workspace.kind === "inReview" && String(w.workspace.version) !== input.version,
  namesNoAskedRun: (w: Workflow, input: { readonly seq: string }): boolean => {
    const { run } = reviewsIn(w);

    return run?.kind !== "requested" || run.seq !== seqOf(input);
  },
  namesNoRunUnderWay: (w: Workflow, input: { readonly seq: string }): boolean =>
    reviewsIn(w).run?.seq !== seqOf(input),
  answersARunNeverLaunched: (w: Workflow, input: { readonly outcome: string }): boolean =>
    input.outcome === "answer" && reviewsIn(w).run?.kind !== "running",
  namesNoAgentToStop: (w: Workflow, input: { readonly seq: string }): boolean =>
    !reviewsIn(w).stopping.some(({ seq }) => seq === seqOf(input)),
});

// The transitions.

function kept(w: Workflow, reviews: Reviews, verdict: readonly Effect[] = []): Outcome {
  return {
    workflow: withRegion(w, regionOf(reviews)),
    effects: [
      ...verdict,
      {
        kind: "writeFile",
        owner: AGENT_REVIEW,
        file: REVIEWS_FILE,
        text: `${JSON.stringify(reviews)}\n`,
      },
    ],
  };
}

/** The run given up, its agent to stop once it has one. */
function runDropped(reviews: Reviews): Reviews {
  const { run, stopping } = reviews;
  const agent = run?.kind === "running" ? [{ seq: run.seq, agentId: run.agentId }] : [];

  return { ...reviews, run: null, stopping: [...stopping, ...agent] };
}

function twoDigits(n: number): string {
  return String(n).padStart(2, "0");
}

/** The agent's text as it wrote it, under vellum's header: the version, the agent, its model, the time of the write. */
function verdictDoc(version: number, model: string, text: string, at: Date): string {
  const time = `${twoDigits(at.getHours())}:${twoDigits(at.getMinutes())}`;

  return `# Plan review · v${version}\n\n\`${REVIEWER}\` · \`${model}\` · ${time}\n\n${text.trimEnd()}\n`;
}

function dateOf(text: string): Date {
  const at = new Date(text);

  if (Number.isNaN(at.getTime())) throw new Error(`not a time: ${text}`);

  return at;
}

function requestReview(w: Workflow, input: Carried<AgentReviewEvents, "requestReview">): Outcome {
  const reviews = reviewsIn(w);
  const seq = reviews.seq + 1;
  const run: Run = { kind: "requested", seq, version: Number(input.version) };

  return kept(w, { ...reviews, seq, run, failed: null });
}

function reviewLaunched(w: Workflow, input: Carried<AgentReviewEvents, "reviewLaunched">): Outcome {
  const reviews = reviewsIn(w);
  const { seq, version } = runIn(w);
  const { agentId, model } = input;

  return kept(w, { ...reviews, run: { kind: "running", seq, version, agentId, model } });
}

/** A verdict lands under the name the route chose from the listing (`input.file`); a failure keeps why, for the page. */
function reviewDone(w: Workflow, input: Carried<AgentReviewEvents, "reviewDone">): Outcome {
  const reviews = reviewsIn(w);
  const run = runIn(w);

  if (input.outcome !== "answer") {
    const model = run.kind === "running" ? run.model : null;
    const failed = { seq: run.seq, version: run.version, model, why: input.why };

    return kept(w, { ...reviews, run: null, failed });
  }

  if (run.kind !== "running") throw new Error("a verdict the rows passed has no running run");
  const text = verdictDoc(run.version, run.model, input.text, dateOf(input.at));

  return kept(w, { ...reviews, run: null, failed: null }, [
    { kind: "writeFile", owner: AGENT_REVIEW, file: input.file, text },
  ]);
}

function reviewStopped(w: Workflow, input: Carried<AgentReviewEvents, "reviewStopped">): Outcome {
  const reviews = reviewsIn(w);
  const stopping = reviews.stopping.filter(({ seq }) => seq !== seqOf(input));

  return kept(w, { ...reviews, stopping });
}

export const TRANSITIONS: Transitions<AgentReviewEvents> = {
  requestReview,
  reviewLaunched,
  reviewDone,
  reviewForgotten: (w) => kept(w, runDropped(reviewsIn(w))),
  reviewClosed: (w) => kept(w, runDropped(reviewsIn(w))),
  reviewStopped,
};

/** A run that ends without a verdict: a failure, a run forgotten, a run closed with the mode. */
export const ENDS_WITHOUT_VERDICT: EndsWithoutVerdict<AgentReviewEvents> = {
  reviewDone: (input) => input.outcome !== "answer",
  reviewForgotten: () => true,
  reviewClosed: () => true,
};

// Its answer to the others' events.

/** The approval gives up the run under way: an answer that comes later finds no run, and writes nothing. */
export const REACTIONS: Reactions<AgentReviewHears> = {
  approve: (w) => {
    const reviews = reviewsIn(w);

    return reviews.run === null ? unchanged(w) : kept(w, runDropped(reviews));
  },
};

// The inputs `refusedNow` and the proof of the table (`proof.ts`) try.

const SEQS = [{ seq: "1" }, { seq: "2" }];

const VERDICT = "## Plan review\n\nStatus: Approved\n";

export const SAMPLES: Samples<AgentReviewEvents> = {
  requestReview: [{ version: "1" }, { version: "2" }],
  reviewLaunched: SEQS.map(({ seq }) => ({
    seq,
    agentId: `agent-${seq}`,
    model: "claude-opus-5-5",
  })),
  reviewDone: SEQS.flatMap(({ seq }) => [
    {
      seq,
      outcome: "answer",
      why: "",
      text: VERDICT,
      file: "reviews/v1-claude-opus-5-5.md",
      at: SAMPLE_AT,
    },
    { seq, outcome: "failed", why: "aborted", text: "", file: "" },
  ]),
  reviewForgotten: SEQS,
  reviewClosed: [{}],
  reviewStopped: SEQS,
};

// How the agent review words its region.

export function segmentOf(region: Region): string | null {
  return region.state === "open" && region.holds !== null ? "agent review · running" : null;
}

/** The run under way, asked or running, or none. */
export function lineOf(region: Region): string {
  const run = region.state === "open" ? reviewsOf(region).run : null;

  return run === null
    ? `${AGENT_REVIEW}: closed`
    : `${AGENT_REVIEW}: plan review ${run.seq} of v${run.version} ${run.kind}`;
}
