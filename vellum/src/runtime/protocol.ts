import type { ChannelLine } from "../workshop/channel.ts";
import type { ProjectPath, Version } from "../workshop/paths.ts";
import type { Stage, WorkflowView } from "../workshop/view.ts";
import type { PlanWorkspace } from "../workshop/workspace.ts";

/**
 * What crosses HTTP between the hooks module, the server and the page, what the server writes on
 * its stdout for the hooks module, and what crosses an extension boundary. Everything here is
 * JSON. The domain types it carries are re-exported, never redefined.
 */

export type { ChannelEntry, ChannelLine } from "../workshop/channel.ts";

export type { CommitSha, PluginVersion, VellumBuild } from "../workshop/vellum-build.ts";

export type { Pill, Refused, RegionView, Stage, WorkflowView } from "../workshop/view.ts";

export type { PlanText, Region, RegionData, Wait } from "../workshop/workflow.ts";

export type { PlanWorkspace } from "../workshop/workspace.ts";

export { takesComments } from "../workshop/workspace.ts";

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

/** What `GET /api/workflow` answers `mcp__vellum__state`: where the review lives, and the workflow as a reader takes it. */
export type WorkflowAnswer = { readonly workspace: PlanWorkspace } & WorkflowView;

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
