import type { ProjectPath } from "./domain/paths.ts";
import type { PlanWorkspace } from "./domain/workspace.ts";

/**
 * What crosses HTTP between the hooks module, the server and the page, and what crosses a
 * plugin boundary. Everything here is JSON. The domain types it carries are re-exported,
 * never redefined.
 */

export type { Anchor, Annotation } from "./domain/feedback.ts";

export type { Decision } from "./domain/review.ts";

export type { Pending, PlanWorkspace } from "./domain/workspace.ts";

export type MediaType = "text/markdown" | "text/html" | `image/${string}`;

export type DocRef = { readonly path: ProjectPath; readonly mediaType: MediaType };

export type ReviewView = {
  readonly workspace: PlanWorkspace;
  readonly plan: { readonly doc: ProjectPath; readonly text: string } | null;
  readonly docs: readonly DocRef[];
};

export type GateInput = { readonly plan: string; readonly planFilePath: string };

export type LinkRoots = { readonly project: string; readonly planDir: string };

/** A server plugin proposes documents linked from the plan; the server keeps those that exist. */
export type ServerPlugin = {
  readonly id: string;
  readonly linkedDocs?: (plan: string, roots: LinkRoots) => readonly DocRef[];
};

export function mediaTypeOf(path: string): MediaType | null {
  const extension = path.split(".").at(-1)?.toLowerCase() ?? "";

  if (extension === "md") return "text/markdown";

  if (extension === "html" || extension === "htm") return "text/html";

  if (extension === "svg") return "image/svg+xml";

  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";

  if (["png", "gif", "webp", "avif"].includes(extension)) return `image/${extension}`;

  return null;
}
