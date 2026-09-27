import type {
  Effect,
  EventDecl,
  EventInput,
  Outcome,
  Region,
  Rule,
  Transition,
  Workflow,
} from "../../core/server/domain/workflow.ts";
import {
  regionIn,
  reviewed,
  SAMPLE_AT,
  unchanged,
  withRegion,
} from "../../core/server/domain/workflow.ts";
import { REVIEW_DIR } from "../../core/server/domain/workspace.ts";
import { parseJson, parseReviews } from "./parse.ts";
import type { Reviews, Run } from "./protocol.ts";
import { REVIEWER } from "./protocol.ts";

/**
 * `review`'s part of the workflow: the runs of `.review/reviews.json`. A run under way, from its
 * request to its end, holds the review, its number part of the reason the approval's warning
 * compares; the numbering and the agents to stop outlive it.
 */

export const REVIEW = "review";

export const REVIEWS_FILE = `${REVIEW_DIR}/reviews.json`;

/** No run yet, and none ever asked. */
export const NO_RUNS: Reviews = { seq: 0, run: null, failed: null, stopping: [] };

const NO_SUCH_RUN = "no such run";

/** Open while a run is asked or running. */
export function regionOf(reviews: Reviews | null): Region {
  const { seq, run, failed, stopping } = reviews ?? NO_RUNS;
  // One order of the fields, whoever wrote the file: the data is compared as a text.
  const data = { reviews: JSON.stringify({ seq, run, failed, stopping }) };

  return run === null
    ? { id: REVIEW, state: "closed", data }
    : {
        id: REVIEW,
        state: "open",
        holds: `plan review ${run.seq} of v${run.version} is running`,
        wait: null,
        data,
      };
}

/** The runs this module serialized itself: runs it cannot read back are a bug, never a state. */
function reviewsIn(w: Workflow): Reviews {
  const text = String(regionIn(w, REVIEW).data.reviews ?? "");
  const reviews = parseReviews(parseJson(text));

  if (reviews === null) throw new Error(`not the runs: ${text}`);

  return reviews;
}

/** The run a row found under way. */
function runIn(w: Workflow): Run {
  const { run } = reviewsIn(w);

  if (run === null) throw new Error("no run is under way");

  return run;
}

function seqOf(input: EventInput): number {
  return Number(input.seq ?? "0");
}

function kept(w: Workflow, reviews: Reviews, verdict: readonly Effect[] = []): Outcome {
  return {
    workflow: withRegion(w, regionOf(reviews)),
    effects: [
      ...verdict,
      {
        kind: "writeFile",
        owner: REVIEW,
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

function dateOf(input: EventInput): Date {
  const at = new Date(input.at ?? "");

  if (Number.isNaN(at.getTime())) throw new Error(`not a time: ${input.at ?? ""}`);

  return at;
}

function requestReview(w: Workflow, _event: string, input: EventInput): Outcome {
  const reviews = reviewsIn(w);
  const seq = reviews.seq + 1;
  const run: Run = { kind: "requested", seq, version: Number(input.version ?? "0") };

  return kept(w, { ...reviews, seq, run, failed: null });
}

function reviewLaunched(w: Workflow, _event: string, input: EventInput): Outcome {
  const reviews = reviewsIn(w);
  const { seq, version } = runIn(w);
  const agentId = input.agentId ?? "";
  const model = input.model ?? "";

  return kept(w, { ...reviews, run: { kind: "running", seq, version, agentId, model } });
}

/** A verdict lands under the name the route chose from the listing (`input.file`); a failure keeps why, for the page. */
function reviewDone(w: Workflow, _event: string, input: EventInput): Outcome {
  const reviews = reviewsIn(w);
  const run = runIn(w);

  if (input.outcome !== "answer") {
    const model = run.kind === "running" ? run.model : null;
    const failed = { seq: run.seq, version: run.version, model, why: input.why ?? "" };

    return kept(w, { ...reviews, run: null, failed });
  }

  if (run.kind !== "running") throw new Error("a verdict the rows passed has no running run");
  const text = verdictDoc(run.version, run.model, input.text ?? "", dateOf(input));

  return kept(w, { ...reviews, run: null, failed: null }, [
    { kind: "writeFile", owner: REVIEW, file: input.file ?? "", text },
  ]);
}

function reviewStopped(w: Workflow, _event: string, input: EventInput): Outcome {
  const reviews = reviewsIn(w);
  const stopping = reviews.stopping.filter(({ seq }) => seq !== seqOf(input));

  return kept(w, { ...reviews, stopping });
}

/** The approval gives up the run under way: an answer that comes later finds no run, and writes nothing. */
export const REACTION: Transition = (w, event) => {
  if (event !== "approve") return unchanged(w);
  const reviews = reviewsIn(w);

  return reviews.run === null ? unchanged(w) : kept(w, runDropped(reviews));
};

export const TRANSITIONS = {
  requestReview,
  reviewLaunched,
  reviewDone,
  reviewForgotten: (w) => kept(w, runDropped(reviewsIn(w))),
  reviewClosed: (w) => kept(w, runDropped(reviewsIn(w))),
  reviewStopped,
} satisfies Readonly<Record<string, Transition>>;

/** Today's `whyNot`, before the hold (P2); an approved plan is the core's own rule, in the same words. */
export const RULES: readonly Rule[] = [
  {
    id: "no-version",
    event: "requestReview",
    order: -3,
    when: (w) => w.workspace.kind === "drafting",
    effect: "refuse",
    refuses: "state",
    reason: () => "no version is under review yet",
  },
  {
    id: "other-version",
    event: "requestReview",
    order: -2,
    when: (w, input) =>
      w.workspace.kind === "inReview" && String(w.workspace.version) !== input.version,
    effect: "refuse",
    refuses: "input",
    reason: (w, input) => `v${reviewed(w)} is under review, not v${input.version ?? ""}`,
  },
  {
    id: "running",
    event: "requestReview",
    order: -1,
    when: (w) => reviewsIn(w).run !== null,
    effect: "refuse",
    refuses: "state",
    reason: (w) => `a review of v${runIn(w).version} is running`,
  },
  {
    id: "no-such-run",
    event: "reviewLaunched",
    order: 1,
    when: (w, input) => {
      const { run } = reviewsIn(w);

      return run?.kind !== "requested" || run.seq !== seqOf(input);
    },
    effect: "refuse",
    refuses: "input",
    reason: () => NO_SUCH_RUN,
  },
  {
    id: "no-such-run",
    event: "reviewDone",
    order: 1,
    when: (w, input) => reviewsIn(w).run?.seq !== seqOf(input),
    effect: "refuse",
    refuses: "input",
    reason: () => NO_SUCH_RUN,
  },
  {
    id: "never-launched",
    event: "reviewDone",
    order: 2,
    when: (w, input) => input.outcome === "answer" && reviewsIn(w).run?.kind !== "running",
    effect: "refuse",
    refuses: "input",
    reason: () => "the run was never launched",
  },
  {
    id: "no-such-run",
    event: "reviewForgotten",
    order: 1,
    when: (w, input) => reviewsIn(w).run?.seq !== seqOf(input),
    effect: "refuse",
    refuses: "input",
    reason: () => NO_SUCH_RUN,
  },
  {
    id: "no-such-run",
    event: "reviewStopped",
    order: 1,
    when: (w, input) => !reviewsIn(w).stopping.some(({ seq }) => seq === seqOf(input)),
    effect: "refuse",
    refuses: "input",
    reason: () => NO_SUCH_RUN,
  },
];

const SEQS = [{ seq: "1" }, { seq: "2" }];

const VERDICT = "## Plan review\n\nStatus: Approved\n";

export const EVENTS: readonly EventDecl[] = [
  {
    id: "requestReview",
    owner: REVIEW,
    actors: ["reviewer"],
    whileHeld: { effect: "refuse", reason: (hold) => hold },
    samples: [{ version: "1" }, { version: "2" }],
  },
  {
    id: "reviewLaunched",
    owner: REVIEW,
    actors: ["engine"],
    whileHeld: { effect: "allow" },
    samples: SEQS.map(({ seq }) => ({ seq, agentId: `agent-${seq}`, model: "claude-opus-5-5" })),
  },
  {
    id: "reviewDone",
    owner: REVIEW,
    actors: ["engine"],
    whileHeld: { effect: "allow" },
    endsWithoutVerdict: (input) => input.outcome !== "answer",
    samples: SEQS.flatMap(({ seq }) => [
      {
        seq,
        outcome: "answer",
        text: VERDICT,
        file: "reviews/v1-claude-opus-5-5.md",
        at: SAMPLE_AT,
      },
      { seq, outcome: "failed", why: "aborted" },
    ]),
  },
  {
    id: "reviewForgotten",
    owner: REVIEW,
    actors: ["reviewer"],
    whileHeld: { effect: "allow" },
    endsWithoutVerdict: () => true,
    samples: SEQS,
  },
  {
    id: "reviewClosed",
    owner: REVIEW,
    actors: ["engine"],
    whileHeld: { effect: "allow" },
    endsWithoutVerdict: () => true,
    samples: [{}],
  },
  {
    id: "reviewStopped",
    owner: REVIEW,
    actors: ["engine"],
    whileHeld: { effect: "allow" },
    samples: SEQS,
  },
];

export function segmentOf(region: Region): string | null {
  return region.state === "open" && region.holds !== null ? "review · running" : null;
}
