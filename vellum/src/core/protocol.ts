import type { ChannelLine } from "./server/domain/channel.ts";
import type { ProjectPath, Version } from "./server/domain/paths.ts";
import type { SendRefused } from "./server/domain/review.ts";
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

export type { PlanWorkspace } from "./server/domain/workspace.ts";

export { takesComments } from "./server/domain/workspace.ts";

/**
 * One line of the server's stdout, as JSON, and nothing else is written there: `ready` first, once
 * the server listens, then an entry of the channel as it is written, and where the review stands
 * each time it changes, for the band above the prompt and never for Claude.
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
  | { readonly type: "stage"; readonly workspace: PlanWorkspace };

/** What `POST /api/gate` answers: the version the browser shows, or why it shows none. */
export type GateAnswer =
  | { readonly version: Version; readonly kept: boolean }
  | { readonly error: string };

/**
 * Why `POST /api/send` wrote nothing: questions no answer takes that the reviewer did not agree to
 * leave to their recommendation, every one of them; what `sendOn` refuses; nothing to send; or a
 * saved draft the server cannot read.
 */
export type SendRefusal =
  | { readonly reason: "unanswered"; readonly ids: readonly string[] }
  | { readonly reason: SendRefused | "empty" | "unreadable" };

/** What `POST /api/send` answers: the batch written and its entry's number, or why none was. */
export type SendAnswer = { readonly file: ProjectPath; readonly seq: number } | SendRefusal;

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
  /** What the first extension that holds the review says holds it, for the greyed button and the approval's warning. */
  readonly held: string | null;
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
