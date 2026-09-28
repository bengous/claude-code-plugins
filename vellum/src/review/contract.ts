/**
 * The review: the frame the parts plug into, not a slice. The reviewer's draft, the Send and its
 * batches, the reviewer's edit, the versions Claude records and the approval are its, and the
 * parts hear its events through the types below. It keeps a slice's files (this contract, its
 * model `events.ts`, a server half, `parse.ts`, its specs beside), but the runtimes reach it by
 * name, never through a registry: `runtime/server/queue.ts` puts its part first in the table,
 * `http/routes.ts` hands it its routes. A part reads it through this file, as types.
 */
import type { ProjectPath, Version } from "../workshop/paths.ts";
import type { PlugsOf } from "../workshop/plugs.ts";
import { defineSlice } from "../workshop/plugs.ts";
import { rows } from "../workshop/rows.ts";
import { held, reviewed } from "../workshop/workflow.ts";
import type { PlanWorkspace } from "../workshop/workspace.ts";
import { PLAN_FILE } from "../workshop/workspace.ts";
import {
  editsAnotherVersion,
  namesPlanCommentsWithoutTheEdit,
  namesWhatTheDraftLost,
  noVersionUnderReview,
  planChangedSinceTheVersion,
  planIsAbsent,
} from "./events.ts";
import type { EditKept } from "./review.ts";

// The review's types, named here for every reader outside review/: defined beside their code.

export type { DiffRun, LineDiff } from "./diff.ts";

export type {
  Anchor,
  Annotation,
  Choice,
  ChoiceRef,
  DecisionKey,
  ElementDescription,
  ElementRef,
  Mark,
  Passage,
  PassageKind,
  QuickLabel,
  SentChoice,
  WordsContext,
} from "./feedback.ts";

export type {
  Choices,
  Decision,
  Draft,
  Edit,
  EditKept,
  SendRefused,
  SendRequest,
  Taking,
  Typed,
} from "./review.ts";

// The wire: what the review's routes answer.

/** What `POST /api/gate` answers: the version the browser shows, or why it shows none. */
export type GateAnswer =
  | { readonly version: Version; readonly kept: boolean }
  | { readonly error: string };

/** What `POST /api/record` answers the reviewer's Record: the version recorded or kept, or the row that refused it. */
export type RecordAnswer =
  | { readonly version: Version }
  | { readonly rule: string; readonly reason: string };

/**
 * What `POST /api/decision` answers: where the review stands after it, and, when a row refused
 * the approval, which one and why; a rename that failed leaves its error in the workspace.
 */
export type DecisionAnswer = {
  readonly workspace: PlanWorkspace;
  readonly rule?: string;
  readonly reason?: string;
};

/**
 * Why `POST /api/send` wrote nothing: questions no answer takes that the reviewer did not agree to
 * leave to their recommendation, every one of them; the row that refused it, by its id, with its
 * text (an edit with nothing else, while the review is held, is the hold's row, and its text what
 * holds); nothing to send; or a saved draft the server cannot read.
 */
export type SendRefusal =
  | { readonly reason: "unanswered"; readonly ids: readonly string[] }
  | { readonly reason: "refused"; readonly rule: string; readonly text: string }
  | { readonly reason: "empty" | "unreadable" };

/**
 * What `POST /api/send` answers: the batch written, its entry's number, and the edit it left in
 * the draft while the review is held; or why nothing was written.
 */
export type SendAnswer =
  | { readonly file: ProjectPath; readonly seq: number; readonly editKept: EditKept | null }
  | SendRefusal;

// The declaration: the events it owns, each with its senders and the fields it carries.

export const REVIEW_EVENTS = defineSlice({
  id: "review",
  events: {
    /** `plan.md` recorded as the next version: Claude's gate, the reviewer's Record. */
    record: { by: ["claude", "reviewer"], carries: ["unchanged"] },
    /** The reviewer's edit, sent, as the next version. */
    sendEdit: { by: ["reviewer"], carries: ["edit", "text"] },
    /** One batch: whether the parts' shares go, each under its part's id beside these fields. */
    send: { by: ["reviewer"], carries: ["parts", "edit", "names", "comments", "text"] },
    /** The approval, confirmed under a hold by naming it. */
    approve: { by: ["reviewer"], carries: ["confirmed", "edit", "text", "notes", "dir", "noted"] },
    /** What the watcher read of `plan.md` against the last version. */
    planWritten: { by: ["claude"], carries: ["plan"] },
  },
});

export type ReviewPlugs = PlugsOf<typeof REVIEW_EVENTS>;

export type ReviewEvents = ReviewPlugs["events"];

// What is refused, read top to bottom per event: every refusal of the review's routes is a 409.

const STALE = "your edit is of a version no longer under review";

const { refuse, whileHeld, confirmWhileHeld } = rows(REVIEW_EVENTS);

export const RULES = [
  whileHeld("record", 409, (hold) => `${hold}: plan.md waits; you are told when it ends`),
  refuse(
    "record",
    "no-plan",
    planIsAbsent,
    409,
    (w) => `write ${PLAN_FILE} in ${w.workspace.dir} first`,
  ),
  refuse("sendEdit", "stale", editsAnotherVersion, 409, STALE),
  whileHeld("sendEdit", 409, (hold) => `${hold}: the edit waits in the draft until it ends`),
  refuse(
    "send",
    "changed",
    namesWhatTheDraftLost,
    409,
    "the saved draft no longer holds what you sent, changed in another tab",
  ),
  refuse("send", "stale", editsAnotherVersion, 409, STALE),
  refuse(
    "send",
    "edit",
    namesPlanCommentsWithoutTheEdit,
    409,
    "a comment on the plan goes with your edit",
  ),
  confirmWhileHeld("approve", 409, (hold) => `The review is held: ${hold}.`),
  refuse("approve", "no-version", noVersionUnderReview, 409, "no version is under review yet"),
  refuse(
    "approve",
    "approve-stale",
    editsAnotherVersion,
    409,
    (w, input) => `v${reviewed(w)} is under review, not v${input.edit}`,
  ),
  refuse("approve", "approve-draft", planChangedSinceTheVersion, 409, (w) => {
    const since = `plan.md changed since v${reviewed(w)}`;
    const hold = held(w);

    return hold === null
      ? `${since}: record it before approving`
      : `${since} while ${hold}: end it, then record plan.md before approving`;
  }),
];
