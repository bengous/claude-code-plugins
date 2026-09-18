import type { ComponentType } from "preact";

import type {
  Annotation,
  DocLink,
  DocRef,
  LineDiff,
  LinkRoots,
  PlanWorkspace,
} from "./protocol.ts";
import type { ProjectPath } from "./server/domain/paths.ts";

export type RendererProps = {
  readonly doc: DocRef;
  readonly annotations: readonly Annotation[];
  readonly annotate: (annotation: Omit<Annotation, "id">) => void;
  /** The reviewer's unsent edit of this document, rendered in place of the file. */
  readonly source: string | null;
  /** The changes to mark while "Changes since" is on; `null` when it is off or the document is not the plan. */
  readonly changes: LineDiff | null;
};

export type Renderer = {
  readonly accepts: (doc: DocRef) => boolean;
  readonly component: ComponentType<RendererProps>;
};

export type PageExtension = {
  readonly id: string;
  readonly renderers?: readonly Renderer[];
  /** Drawn in the decision bar, before the decision's own buttons, in registry order. */
  readonly actions?: readonly ComponentType[];
};

/**
 * What an extension's routes may read and write, bound in `serve.ts` to the review and to
 * `adapters/fs.ts`: an extension never imports an adapter. `workspace().dir` is the plan's
 * directory now, the final one once approved, so a route resolves it at each write.
 */
export type ServerContext = {
  /** Throws when the working directory is gone and the server lost its memory. */
  readonly workspace: () => Promise<PlanWorkspace>;
  readonly listFiles: (dir: PlanWorkspace["dir"]) => Promise<readonly DocRef[]>;
  readonly readText: (path: ProjectPath) => Promise<string | null>;
  readonly writeText: (path: ProjectPath, text: string) => Promise<void>;
  /** Tells the page the workspace again: what the watcher cannot see, or no longer watches. */
  readonly notify: () => Promise<void>;
};

export type Route = (request: Request) => Promise<Response>;

export type RouteKey = `${"GET" | "POST"} ${string}`;

/**
 * A server extension proposes documents linked from the plan, and the server keeps those that
 * exist; it brings its own routes, mounted at `/api/x/<id>/<name>` behind the token.
 */
export type ServerExtension = {
  readonly id: string;
  readonly linkedDocs?: (plan: string, roots: LinkRoots) => readonly DocLink[];
  /** Keys are `"GET <name>"` or `"POST <name>"`. */
  readonly routes?: (context: ServerContext) => Readonly<Record<RouteKey, Route>>;
};
