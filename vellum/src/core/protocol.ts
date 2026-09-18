import type { ProjectPath, Version } from "./server/domain/paths.ts";
import type { PlanWorkspace } from "./server/domain/workspace.ts";

/**
 * What crosses HTTP between the hooks module, the server and the page, and what crosses an
 * extension boundary. Everything here is JSON. The domain types it carries are re-exported,
 * never redefined.
 */

export type { DiffRun, LineDiff } from "./server/domain/diff.ts";

export { countChanges, lineDiff, shiftAnnotations } from "./server/domain/diff.ts";

export type {
  Anchor,
  Annotation,
  ElementRef,
  Mark,
  Passage,
  QuickLabel,
} from "./server/domain/feedback.ts";

export { DELETE_SENTENCE, QUICK_LABELS } from "./server/domain/feedback.ts";

export type { Decision, Draft, Edit } from "./server/domain/review.ts";

export { editOnLoad, landedAnnotations } from "./server/domain/review.ts";

export type { Pending, PlanWorkspace } from "./server/domain/workspace.ts";

export { takesComments } from "./server/domain/workspace.ts";

/** What `POST /api/gate` answers: the version the browser shows, or why it shows none. */
export type GateAnswer =
  | { readonly version: Version; readonly kept: boolean }
  | { readonly error: string };

export type MediaType = "text/markdown" | "text/html" | `image/${string}`;

/** A document an extension proposes; the server checks it exists before it becomes a `DocRef`. */
export type DocLink = { readonly path: ProjectPath; readonly mediaType: MediaType };

/** `modified` is the file's mtime in ms: the page refetches a document when it changes. */
export type DocRef = DocLink & { readonly modified: number };

export type ReviewView = {
  readonly workspace: PlanWorkspace;
  readonly plan: {
    readonly doc: ProjectPath;
    readonly text: string;
    /** The version before this one, for the page to diff against; `null` at v1. */
    readonly previous: { readonly version: Version; readonly text: string } | null;
  } | null;
  readonly docs: readonly DocRef[];
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
