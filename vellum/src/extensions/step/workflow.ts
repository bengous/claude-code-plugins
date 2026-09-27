import type {
  Effect,
  EventDecl,
  EventInput,
  Outcome,
  Region,
  RegionData,
  Rule,
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
import { answerText, ownText } from "./moves.ts";
import { parseAnswer, parseJson, parseProposal } from "./parse.ts";
import type { Dropped, Move, Pending, Proposal, StepAnswer, StepFile } from "./protocol.ts";

/**
 * `step`'s part of the workflow: the one proposal waiting for the reviewer, read off
 * `.review/step.json`, and whether Claude's call still waits on it, which is the server's memory.
 */

export const STEP = "step";

/** Where the proposals live, so a restarted server still shows the one waiting. */
export const STEP_FILE = `${REVIEW_DIR}/step.json`;

const EMPTY: StepFile = { pending: null, answered: null, dropped: null };

export const NO_SUCH_PROPOSAL = "no such proposal";

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

function placed(w: Workflow, file: StepFile, wait: Wait | null): Workflow {
  const region = regionOf(file);

  return withRegion(w, region.state === "open" ? { ...region, wait } : region);
}

function written(file: StepFile): Effect {
  return { kind: "writeFile", owner: STEP, file: STEP_FILE, text: `${JSON.stringify(file)}\n` };
}

function waitOn(w: Workflow, input: EventInput, wait: Wait): Outcome {
  const region = regionIn(w, STEP);

  if (region.state !== "open" || region.data.pending !== input.id) return unchanged(w);

  return { workflow: withRegion(w, { ...region, wait }), effects: [] };
}

function offersPlan(proposal: Proposal): boolean {
  return proposal.moves.some((move) => move.kind === "plan");
}

/** A newer proposal replaces the one waiting, and Claude's call waits on it. */
function propose(w: Workflow, _event: string, input: EventInput): Outcome {
  const { pending, answered, dropped } = fileOf(regionIn(w, STEP));

  const next: StepFile = {
    pending: { id: input.id ?? "", proposal: proposalOf(input.proposal ?? "") },
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
function answerProposal(w: Workflow, _event: string, input: EventInput): Outcome {
  const region = regionIn(w, STEP);
  const { pending, dropped } = fileOf(region);
  const answer = answerOf(input.answer ?? "");

  const told =
    (input.id ?? "") === "" ? ownText(answer, pending !== null) : answerText(answer, pending);

  const opened = input.opened ?? "";
  const text = opened === "" ? told : `${told} ${opened}`;
  const entry: Effect = { kind: "channel", entry: { kind: "text", from: STEP, text } };

  if (pending === null) return { workflow: w, effects: [entry] };

  const next: StepFile = {
    pending: null,
    answered: { id: pending.id, seq: Number(input.seq ?? "0"), text },
    dropped,
  };

  const returned: readonly Effect[] =
    region.state === "open" && region.wait === "open"
      ? [{ kind: "returnToCall", call: pending.id, text }]
      : [];

  return { workflow: placed(w, next, null), effects: [entry, written(next), ...returned] };
}

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

  if (pending === null || !offersPlan(pending.proposal)) return unchanged(w);
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

export const TRANSITIONS = {
  propose,
  wait: (w, _event, input) => waitOn(w, input, "open"),
  pause: (w, _event, input) => waitOn(w, input, "paused"),
  answerProposal,
} satisfies Readonly<Record<string, Transition>>;

function pendingId(w: Workflow): string {
  return String(regionIn(w, STEP).data.pending ?? "");
}

export const RULES: readonly Rule[] = [
  {
    id: "plan-over-plan",
    event: "propose",
    order: 1,
    when: (w, input) => planExists(w) && offersPlan(proposalOf(input.proposal ?? "")),
    effect: "refuse",
    refuses: "state",
    reason: () => "plan.md exists: the plan step is done",
  },
  {
    id: "no-such-proposal",
    event: "pause",
    order: 1,
    when: (w, input) => pendingId(w) === "" || pendingId(w) !== input.id,
    effect: "refuse",
    refuses: "input",
    reason: () => NO_SUCH_PROPOSAL,
  },
  {
    id: "no-such-proposal",
    event: "answerProposal",
    order: 1,
    when: (w, input) => (input.id ?? "") !== "" && pendingId(w) !== input.id,
    effect: "refuse",
    refuses: "input",
    reason: () => NO_SUCH_PROPOSAL,
  },
];

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
function answerSample(id: string, answer: StepAnswer): EventInput {
  const move = answer.kind === "own" ? "own" : answer.move.kind;
  const subject = answer.kind === "move" && answer.move.kind === "grill" ? answer.move.subject : "";
  const opened = subject === "" ? "" : `The reviewer opened a grill on: ${subject}.`;

  return { id, answer: JSON.stringify(answer), move, subject, seq: "1", opened, at: SAMPLE_AT };
}

const GRILL_MOVE: StepAnswer = { kind: "move", move: AUTH_GRILL };

export const EVENTS: readonly EventDecl[] = [
  {
    id: "propose",
    owner: STEP,
    actors: ["claude"],
    whileHeld: { effect: "refuse", reason: (hold) => `${hold}: no step is proposed until it ends` },
    samples: [
      { id: "p1", proposal: JSON.stringify(PLAN_ONLY) },
      { id: "p2", proposal: JSON.stringify(GRILL_OR_PLAN) },
      { id: "p3", proposal: JSON.stringify(MOCKUP) },
    ],
  },
  { id: "wait", owner: STEP, actors: ["engine"], whileHeld: { effect: "allow" }, samples: IDS },
  { id: "pause", owner: STEP, actors: ["engine"], whileHeld: { effect: "allow" }, samples: IDS },
  {
    id: "answerProposal",
    owner: STEP,
    actors: ["reviewer"],
    whileHeld: { effect: "refuse", reason: (hold) => hold },
    samples: [
      answerSample("", { kind: "own", text: "Write the plan." }),
      answerSample("", GRILL_MOVE),
      answerSample("p1", { kind: "move", move: { kind: "plan" } }),
      answerSample("p2", GRILL_MOVE),
      answerSample("p3", { kind: "move", move: { kind: "mockup", screen: "login" } }),
    ],
  },
];

/** `step` draws no segment in the band. */
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
