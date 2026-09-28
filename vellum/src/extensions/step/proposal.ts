import type { Carried, Samples, Sent, Stamps, Transitions } from "../../core/server/domain/rows.ts";
import type {
  Effect,
  Outcome,
  Region,
  RegionData,
  Transition,
  Wait,
  Workflow,
} from "../../core/server/domain/workflow.ts";
import {
  planExists,
  regionIn,
  SAMPLE_AT,
  unchanged,
  withRegion,
} from "../../core/server/domain/workflow.ts";
import { REVIEW_DIR } from "../../core/server/domain/workspace.ts";
import type {
  Dropped,
  Move,
  Pending,
  Proposal,
  StepAnswer,
  StepEvents,
  StepPlugs,
} from "./contract.ts";
import { answerText, ownText } from "./moves.ts";
import { parseAnswer, parseJson, parseProposal } from "./parse.ts";

/**
 * The step's part of the workflow: the one proposal waiting for the reviewer, read off
 * `.review/step.json`, and whether Claude's call still waits on it, which is the server's memory.
 */

export const STEP: StepPlugs["id"] = "step";

/** Where the proposals live, so a restarted server still shows the one waiting. */
export const STEP_FILE = `${REVIEW_DIR}/step.json`;

/**
 * `.review/step.json`: the proposal waiting, the last one answered under the entry that told it,
 * and the last one dropped and why, for the waits on them. Whether Claude's call still waits is
 * the server's memory, never written: a restarted server reads it paused.
 */
export type StepFile = {
  readonly pending: Pending | null;
  readonly answered: { readonly id: string; readonly seq: number; readonly text: string } | null;
  readonly dropped: { readonly id: string; readonly why: Dropped } | null;
};

const EMPTY: StepFile = { pending: null, answered: null, dropped: null };

function dataOf({ pending, answered, dropped }: StepFile): RegionData {
  return {
    pending: pending?.id ?? "",
    proposal: pending === null ? "" : JSON.stringify(pending.proposal),
    answered: answered?.id ?? "",
    seq: answered?.seq ?? 0,
    text: answered?.text ?? "",
    dropped: dropped?.id ?? "",
    why: dropped?.why ?? "",
  };
}

/** A proposal this module serialized itself: one it cannot read back is a bug, never a state. */
function proposalOf(text: string): Proposal {
  const proposal = parseProposal(parseJson(text));

  if (proposal === null) throw new Error(`not a proposal: ${text}`);

  return proposal;
}

function answerOf(text: string): StepAnswer {
  const answer = parseAnswer({ id: null, answer: parseJson(text) })?.answer;

  if (answer === undefined) throw new Error(`not an answer: ${text}`);

  return answer;
}

function whyOf(text: string): Dropped {
  if (text === "replaced" || text === "approved" || text === "written") return text;

  throw new Error(`not why a proposal was dropped: ${text}`);
}

/** The file a region holds, as `regionOf` spelled it. */
export function fileOf(region: Region): StepFile {
  const { data } = region;
  const pending = String(data.pending ?? "");
  const answered = String(data.answered ?? "");
  const dropped = String(data.dropped ?? "");

  return {
    pending: pending === "" ? null : { id: pending, proposal: proposalOf(String(data.proposal)) },
    answered:
      answered === ""
        ? null
        : { id: answered, seq: Number(data.seq ?? 0), text: String(data.text ?? "") },
    dropped: dropped === "" ? null : { id: dropped, why: whyOf(String(data.why ?? "")) },
  };
}

/**
 * Open while a proposal waits. Whether Claude's call waits on it is the server's memory: `before`,
 * the region the server's last step left, while the same proposal waits; paused otherwise, as
 * after a start, since no call survives a server that did not say so.
 */
export function regionOf(file: StepFile | null, before: Region | null = null): Region {
  const known = file ?? EMPTY;
  const data = dataOf(known);

  if (known.pending === null) return { id: STEP, state: "closed", data };
  const same = before?.state === "open" && before.data.pending === known.pending.id;

  return { id: STEP, state: "open", holds: null, wait: same ? before.wait : "paused", data };
}

/** The proposal waiting now, `null` with none. */
export function pendingOf(w: Workflow): Pending | null {
  return fileOf(regionIn(w, STEP)).pending;
}

function pendingId(w: Workflow): string {
  return String(regionIn(w, STEP).data.pending ?? "");
}

function hasPlan(proposal: Proposal): boolean {
  return proposal.moves.some((move) => move.kind === "plan");
}

// The guards the rows of `contract.ts` are built from, each stating the fields it reads.

export const offersPlan = (_w: Workflow, input: { readonly proposal: string }): boolean =>
  hasPlan(proposalOf(input.proposal));

export const noProposalWaits = (w: Workflow): boolean => pendingId(w) === "";

export const namesAProposal = (_w: Workflow, input: { readonly id: string }): boolean =>
  input.id !== "";

export const namesAnotherProposal = (w: Workflow, input: { readonly id: string }): boolean =>
  pendingId(w) !== input.id;

// The transitions.

function placed(w: Workflow, file: StepFile, wait: Wait | null): Workflow {
  const region = regionOf(file);

  return withRegion(w, region.state === "open" ? { ...region, wait } : region);
}

function written(file: StepFile): Effect {
  return { kind: "writeFile", owner: STEP, file: STEP_FILE, text: `${JSON.stringify(file)}\n` };
}

function waitOn(w: Workflow, id: string, wait: Wait): Outcome {
  const region = regionIn(w, STEP);

  if (region.state !== "open" || region.data.pending !== id) return unchanged(w);

  return { workflow: withRegion(w, { ...region, wait }), effects: [] };
}

/** A newer proposal replaces the one waiting, and Claude's call waits on it. */
function propose(w: Workflow, input: Carried<StepEvents, "propose">): Outcome {
  const { pending, answered, dropped } = fileOf(regionIn(w, STEP));

  const next: StepFile = {
    pending: { id: input.id, proposal: proposalOf(input.proposal) },
    answered,
    dropped: pending === null ? dropped : { id: pending.id, why: "replaced" },
  };

  return { workflow: placed(w, next, "open"), effects: [written(next)] };
}

/**
 * The reviewer's answer: always an entry of the channel, which a call still waiting claims as its
 * result, else a prompt. The window opened blank settles the proposal waiting all the same, since
 * a grill it opens holds the review; `input.opened` is what the extension it starts tells.
 */
function answerProposal(w: Workflow, input: Carried<StepEvents, "answerProposal">): Outcome {
  const region = regionIn(w, STEP);
  const { pending, dropped } = fileOf(region);
  const answer = answerOf(input.answer);
  const told = input.id === "" ? ownText(answer, pending !== null) : answerText(answer, pending);
  const text = input.opened === "" ? told : `${told} ${input.opened}`;
  const entry: Effect = { kind: "channel", entry: { kind: "text", from: STEP, text } };

  if (pending === null) return { workflow: w, effects: [entry] };

  const next: StepFile = {
    pending: null,
    answered: { id: pending.id, seq: Number(input.seq), text },
    dropped,
  };

  const returned: readonly Effect[] =
    region.state === "open" && region.wait === "open"
      ? [{ kind: "returnToCall", call: pending.id, text }]
      : [];

  return { workflow: placed(w, next, null), effects: [entry, written(next), ...returned] };
}

export const TRANSITIONS: Transitions<StepEvents> = {
  propose,
  wait: (w, input) => waitOn(w, input.id, "open"),
  pause: (w, input) => waitOn(w, input.id, "paused"),
  answerProposal,
};

// Its answer to the others' events.

function drop(w: Workflow, why: Dropped): Outcome {
  const { pending, answered } = fileOf(regionIn(w, STEP));

  if (pending === null) return unchanged(w);
  const next: StepFile = { pending: null, answered, dropped: { id: pending.id, why } };

  return { workflow: placed(w, next, null), effects: [written(next)] };
}

/** The proposal's other moves, the recommendation kept on its move, or the first when it was the plan; `null` with none left. */
function withoutPlan(proposal: Proposal): Proposal | null {
  const moves = proposal.moves.filter((move) => move.kind !== "plan");

  if (moves.length === 0) return null;
  const chosen = proposal.moves[proposal.recommended];
  const recommended = chosen === undefined || chosen.kind === "plan" ? 0 : moves.indexOf(chosen);

  return { ...proposal, moves, recommended };
}

/** `plan.md` written: the plan step is done, so the proposal waiting offers it no more (D17). */
function planDone(w: Workflow): Outcome {
  const region = regionIn(w, STEP);
  const file = fileOf(region);
  const { pending } = file;

  if (pending === null || !hasPlan(pending.proposal)) return unchanged(w);
  const proposal = withoutPlan(pending.proposal);

  if (proposal === null) return drop(w, "written");
  const next: StepFile = { ...file, pending: { ...pending, proposal } };
  const wait = region.state === "open" ? region.wait : null;

  return { workflow: placed(w, next, wait), effects: [written(next)] };
}

/** `plan.md` is written by Claude, which the watcher reads, or by the reviewer's edit. */
const WRITES_PLAN = new Set(["planWritten", "sendEdit"]);

export const REACTION: Transition = (w, event) => {
  if (event === "approve") return drop(w, "approved");

  return WRITES_PLAN.has(event) && planExists(w) ? planDone(w) : unchanged(w);
};

// The inputs `refusedNow` and the walk of `workflow.spec.ts` try.

const PLAN_ONLY: Proposal = {
  reason: "The plan is next.",
  moves: [{ kind: "plan" }],
  recommended: 0,
};

const AUTH_GRILL: Move = { kind: "grill", subject: "auth", choices: ["storage"] };

const GRILL_OR_PLAN: Proposal = {
  reason: "Storage is open.",
  moves: [AUTH_GRILL, { kind: "plan" }],
  recommended: 0,
};

const MOCKUP: Proposal = {
  reason: "The screen is unsettled.",
  moves: [{ kind: "mockup", screen: "login" }],
  recommended: 0,
};

const IDS = [{ id: "p1" }, { id: "p2" }, { id: "p3" }];

/** An answer as the route hands it over: the grill a move opens reads its subject and time, and tells Claude through `opened`. */
function answerSample(
  id: string,
  answer: StepAnswer,
): Sent<StepEvents, "answerProposal"> & Partial<Stamps> {
  const move = answer.kind === "own" ? "own" : answer.move.kind;
  const subject = answer.kind === "move" && answer.move.kind === "grill" ? answer.move.subject : "";
  const opened = subject === "" ? "" : `The reviewer opened a grill on: ${subject}.`;

  return { id, answer: JSON.stringify(answer), move, subject, seq: "1", opened, at: SAMPLE_AT };
}

const GRILL_MOVE: StepAnswer = { kind: "move", move: AUTH_GRILL };

export const SAMPLES: Samples<StepEvents> = {
  propose: [
    { id: "p1", proposal: JSON.stringify(PLAN_ONLY) },
    { id: "p2", proposal: JSON.stringify(GRILL_OR_PLAN) },
    { id: "p3", proposal: JSON.stringify(MOCKUP) },
  ],
  wait: IDS,
  pause: IDS,
  answerProposal: [
    answerSample("", { kind: "own", text: "Write the plan." }),
    answerSample("", GRILL_MOVE),
    answerSample("p1", { kind: "move", move: { kind: "plan" } }),
    answerSample("p2", GRILL_MOVE),
    answerSample("p3", { kind: "move", move: { kind: "mockup", screen: "login" } }),
  ],
};

// How the step words its region.

/** The step draws no segment in the band. */
export function segmentOf(_region: Region): string | null {
  return null;
}

/** The proposal waiting and whether Claude's call waits on it, or none. */
export function lineOf(region: Region): string {
  const { pending } = fileOf(region);

  return region.state === "closed" || pending === null
    ? "step: none"
    : `step: proposal ${pending.id} · wait: ${region.wait ?? "none"}`;
}
