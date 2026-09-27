import type { ChannelLine } from "./server/domain/channel.ts";
import type { ProjectPath, Version } from "./server/domain/paths.ts";
import type { EditKept } from "./server/domain/review.ts";
import type { Stage, WorkflowView } from "./server/domain/workflow.ts";
import type { PlanWorkspace } from "./server/domain/workspace.ts";

/**
 * What crosses HTTP between the hooks module, the server and the page, what the server writes on
 * its stdout for the hooks module, and what crosses an extension boundary. Everything here is
 * JSON. The domain types it carries are re-exported, never redefined.
 */

export type { ChannelEntry, ChannelLine } from "./server/domain/channel.ts";

export type { DiffRun, LineDiff } from "./server/domain/diff.ts";

export {
  countChanges,
  goneWithEdit,
  lineDiff,
  shiftAnnotations,
  unshiftAnnotations,
} from "./server/domain/diff.ts";

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
} from "./server/domain/feedback.ts";

export { DELETE_SENTENCE, QUICK_LABELS } from "./server/domain/feedback.ts";

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
} from "./server/domain/review.ts";

export {
  choicesIn,
  draftIsEmpty,
  editOnLoad,
  EMPTY_TYPED,
  landedAnnotations,
  refOf,
  withoutChoices,
} from "./server/domain/review.ts";

export type { CommitSha, PluginVersion, VellumBuild } from "./server/domain/vellum-build.ts";

export type {
  Pill,
  PlanText,
  Refused,
  Region,
  RegionData,
  RegionView,
  Stage,
  Wait,
  WorkflowView,
} from "./server/domain/workflow.ts";

export type { PlanWorkspace } from "./server/domain/workspace.ts";

export { takesComments } from "./server/domain/workspace.ts";

/**
 * One line of the server's stdout, as JSON, and nothing else is written there: `ready` first, once
 * the server listens, then an entry of the channel as it is written, and where the review stands
 * each time it changes, for the band above the prompt and never for Claude: the pill and the
 * segments come ready-made, since the hooks module imports nothing of the server.
 */
export type ServerLine =
  | {
      readonly type: "ready";
      readonly port: number;
      readonly token: string;
      readonly pid: number;
      /** The channel's identity (`.review/channel.id`): the module keys what it relayed by it. */
      readonly channel: string;
    }
  | { readonly type: "channel"; readonly line: ChannelLine }
  | ({ readonly type: "stage" } & Stage);

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

export type MediaType = "text/markdown" | "text/html" | `image/${string}`;

/** A document an extension proposes; the server checks it exists before it becomes a `DocRef`. */
export type DocLink = { readonly path: ProjectPath; readonly mediaType: MediaType };

/** `modified` is the file's mtime in ms: the page refetches a document when it changes. */
export type DocRef = DocLink & { readonly modified: number };

/** Where a document comes from, seen from the plan: the plan itself, a file of its directory, a file it cites. */
export type DocGroup = "plan" | "artifact" | "cited";

/** A document as the review classes it. `DocRef` stays what a file is, with no origin. */
export type GroupedDoc = DocRef & { readonly group: DocGroup };

export type ReviewView = {
  readonly workspace: PlanWorkspace;
  readonly plan: {
    readonly doc: ProjectPath;
    readonly text: string;
    /** The file the version was taken from, left out of `docs`: a link to it names the plan. */
    readonly workingCopy: ProjectPath;
    /** The version before this one, for the page to diff against; `null` at v1. */
    readonly previous: { readonly version: Version; readonly text: string } | null;
  } | null;
  readonly docs: readonly GroupedDoc[];
  /** The workflow as a reader takes it: what holds the review, the pill, what is refused now. */
  readonly workflow: WorkflowView;
};

export type LinkRoots = { readonly project: string; readonly planDir: string };

export function mediaTypeOf(path: string): MediaType | null {
  const extension = path.split(".").at(-1)?.toLowerCase() ?? "";

  if (extension === "md") return "text/markdown";

  if (extension === "html" || extension === "htm") return "text/html";

  if (extension === "svg") return "image/svg+xml";

  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";

  if (["png", "gif", "webp", "avif"].includes(extension)) return `image/${extension}`;

  return null;
}
