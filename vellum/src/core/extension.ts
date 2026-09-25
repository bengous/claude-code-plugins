import type { ComponentType } from "preact";

import type {
  Annotation,
  ChannelEntry,
  DocLink,
  DocRef,
  Draft,
  LineDiff,
  LinkRoots,
  PlanWorkspace,
  Typed,
} from "./protocol.ts";
import type { ParseResult, ProjectPath } from "./server/domain/paths.ts";

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
  /** `false` for a document that takes no comment, as a grill's transcript: no switch, no comments panel. */
  readonly comments?: false;
  readonly component: ComponentType<RendererProps>;
};

/** A pane the core draws beside the document pane while `shown()` holds; keyed by its extension's id. */
export type Panel = {
  readonly shown: () => boolean;
  readonly component: ComponentType;
};

/**
 * What an extension adds to the Send the bar draws, read at each render and snapshotted at the
 * click: what `Send (n)` counts, the ids of its questions no answer takes, which the bar asks
 * about before it sends, and something of its own the count leaves out (the grill's note).
 */
export type SendShare = {
  readonly count: number;
  readonly unanswered: readonly string[];
  readonly more: boolean;
  /**
   * Once the server took the Send: the extension reads its state again, then takes out of the
   * page's typing what this snapshot sent. The Send stays out until it resolves.
   */
  readonly sent: () => Promise<void>;
};

export type PageExtension = {
  readonly id: string;
  readonly renderers?: readonly Renderer[];
  /** Its part of the one Send: the bar counts it, and asks about what it would take by default. */
  readonly send?: () => SendShare;
  /** Drawn in the decision bar, before the decision's own buttons, in registry order. */
  readonly actions?: readonly ComponentType[];
  /** Drawn in the notices column under the bar, in the flow, after the core's own: the grill's proposal, a modal. */
  readonly notices?: readonly ComponentType[];
  /** Placed among the panes by `panesOf` of `page/panes.ts`: the grill's, while one is open. */
  readonly panel?: Panel;
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
  /**
   * The review's one queue: a gate, a decision and an extension's write never interleave.
   * `holds` and `approved` already run inside it, so calling it from them would wait forever.
   */
  readonly inOrder: <T>(work: () => Promise<T>) => Promise<T>;
  /**
   * Appends an entry to the channel, the one way anything reaches Claude, and answers its number.
   * Called inside the queue, from a route's `inOrder` step, so the entries keep the order of the
   * writes they tell of.
   */
  readonly relay: (entry: ChannelEntry) => Promise<number>;
  /** The page's unsent work as it was last saved; `null` when there is none, or none it can read. */
  readonly draft: () => Promise<Draft | null>;
  /**
   * Calls the `start` of the extension `id` in the caller's step of the queue, so what it starts
   * and the write that asked for it are one step: `step` opens a grill this way, and two never open.
   */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- `input` crosses the core from one extension to another, typed in neither's terms here; the started extension's `parse.ts` is the boundary that reads it.
  readonly start: (id: string, input: unknown) => Promise<ParseResult<string>>;
  /** What holds the review, the first `holds` of any extension; called inside the queue. */
  readonly held: () => Promise<string | null>;
  /**
   * Holds a request while `waiting` says what `read` answers still waits, reading again at each
   * `wake`, and answers the last read after `WAIT_HOLD_MS` at most: the engine cuts every
   * `$.http.fetch` at 30 s. A tool that waits for the reviewer is answered this way.
   */
  readonly hold: <T>(read: () => Promise<T>, waiting: (value: T) => boolean) => Promise<T>;
  /** Wakes every held request of the review to read again: a write may have settled it. */
  readonly wake: () => void;
};

/** A batch a Send wrote, as an extension's part hears of it once its entry is in the channel. */
export type SentBatch = {
  readonly file: ProjectPath;
  readonly seq: number;
  /** Whether the batch holds more than this extension's part: comments, an edit, another's part. */
  readonly more: boolean;
};

/**
 * An extension's part of a Send, read and decided before anything is written: none; questions no
 * answer takes, which the reviewer did not agree to leave to their recommendation (every one of
 * them, so the page asks about all); or its text, what the draft keeps of its typing, and what
 * it closes once the batch and its entry exist.
 */
export type Part =
  | { readonly kind: "none" }
  | { readonly kind: "unanswered"; readonly ids: readonly string[] }
  | {
      readonly kind: "part";
      /** Heading included, written into the batch before the comments. */
      readonly text: string;
      readonly typed: (typed: Typed) => Typed;
      readonly commit: (batch: SentBatch) => Promise<void>;
    };

export type Route = (request: Request) => Promise<Response>;

export type RouteKey = `${"GET" | "POST"} ${string}`;

/**
 * A server extension proposes documents linked from the plan, and the server keeps those that
 * exist and lie under no `.review/`, its own or another plan's; it brings its own routes,
 * mounted at `/api/x/<id>/<name>` behind the token.
 */
export type ServerExtension = {
  readonly id: string;
  readonly linkedDocs?: (plan: string, roots: LinkRoots) => readonly DocLink[];
  /** Keys are `"GET <name>"` or `"POST <name>"`. */
  readonly routes?: (context: ServerContext) => Readonly<Record<RouteKey, Route>>;
  /**
   * What holds the review, or `null`. Held: no version is recorded, `step` takes no proposal, and
   * the approval warns; a Send goes.
   */
  readonly holds?: (context: ServerContext) => Promise<string | null>;
  /**
   * What another extension's route starts through `ServerContext.start`, inside that route's step
   * of the queue: `input` is parsed here. It answers what Claude is told of the start, which the
   * caller's entry carries, or why it refused.
   */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- `input` comes from another extension through the core; this extension's `parse.ts` is the boundary that reads it.
  readonly start?: (context: ServerContext, input: unknown) => Promise<ParseResult<string>>;
  /** After the rename of an approval, on the server: what the extension must close, it closes here. */
  readonly approved?: (context: ServerContext) => Promise<void>;
  /**
   * Its part of the bar's Send, in the Send's step of the queue, and never of a Send now. It
   * writes nothing: the core writes the batch and its entry, then runs the part's `commit`.
   */
  readonly part?: (
    context: ServerContext,
    draft: Draft,
    takeDefaults: readonly string[],
  ) => Promise<Part>;
};
