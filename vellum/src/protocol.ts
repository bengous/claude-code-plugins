import type { FinalDir, ProjectPath, Version, WipDir } from "./workspace/paths.ts";

export type PlanWorkspace =
  | { readonly kind: "drafting"; readonly dir: WipDir }
  | {
      readonly kind: "inReview";
      readonly dir: WipDir;
      readonly version: Version;
      readonly finalizeError: string | null;
    }
  | { readonly kind: "changesRequested"; readonly dir: WipDir; readonly version: Version }
  | { readonly kind: "approvedPending"; readonly dir: WipDir; readonly version: Version }
  | {
      readonly kind: "finalizing";
      readonly from: WipDir;
      readonly to: FinalDir;
      readonly version: Version;
    }
  | { readonly kind: "approved"; readonly dir: FinalDir; readonly version: Version };

export type MediaType = "text/markdown" | "text/html" | `image/${string}`;

export type DocRef = { readonly path: ProjectPath; readonly mediaType: MediaType };

export type Anchor =
  | { readonly kind: "global" }
  | {
      readonly kind: "text";
      readonly quote: string;
      readonly prefix: string;
      readonly suffix: string;
      readonly lines: readonly [number, number];
    };

export type Annotation = {
  readonly id: string;
  readonly doc: ProjectPath;
  readonly anchor: Anchor;
  readonly body: string;
};

export type ReviewView = {
  readonly workspace: PlanWorkspace;
  readonly plan: { readonly doc: ProjectPath; readonly text: string } | null;
  readonly docs: readonly DocRef[];
};

export type Pending =
  | { readonly kind: "none" }
  | { readonly kind: "feedback"; readonly version: Version; readonly path: ProjectPath }
  | { readonly kind: "approved"; readonly version: Version };

export type Decision =
  | { readonly kind: "approve" }
  | { readonly kind: "feedback"; readonly annotations: readonly Annotation[] };

export type GateInput = { readonly plan: string; readonly planFilePath: string };

export type FinalizeInput = { readonly version: Version };

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
