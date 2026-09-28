import type { ComponentType } from "preact";

import type { AnswerOf, InputOf, Json, Parser, Plugs, ReadingOf } from "./plugs.ts";
import type {
  Annotation,
  DocLink,
  DocRef,
  Draft,
  LineDiff,
  LinkRoots,
  PlanWorkspace,
  Typed,
} from "./protocol.ts";
import type { ProjectPath } from "./server/domain/paths.ts";
import type { Events, Heard, Sender, Sent, SlicePart } from "./server/domain/rows.ts";
import type {
  Actor,
  EventInput,
  RefusalStatus,
  Region,
  Step,
  TablePart,
  Workflow,
} from "./server/domain/workflow.ts";

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

/** What a route reads in the queue, off the workflow as it stands, before its event is judged. */
export type Reading = (w: Workflow) => Promise<EventInput>;

/** A step the server ran: the verdict, the workflow after it, and the numbers of the entries it appended. */
export type Dispatched = Step & { readonly appended: readonly number[] };

/** A call's answer a step handed it (`returnToCall`): the entry it claims, and its text. */
export type Returned = { readonly seq: number; readonly text: string };

/**
 * What an extension's routes may read, bound in `serve.ts` to the review and to
 * `adapters/fs.ts`: an extension never imports an adapter, and writes only through `dispatch`.
 * `workspace().dir` is the plan's directory now, the final one once approved, so a route
 * resolves it at each read.
 */
export type ServerContext = {
  /** Throws when the working directory is gone and the server lost its memory. */
  readonly workspace: () => Promise<PlanWorkspace>;
  readonly listFiles: (dir: PlanWorkspace["dir"]) => Promise<readonly DocRef[]>;
  readonly readText: (path: ProjectPath) => Promise<string | null>;
  /**
   * The review's one queue: every step and every read a step must see whole. `dispatch` and a
   * `Reading` already run inside it, so calling it from them would wait forever.
   */
  readonly inOrder: <T>(work: () => Promise<T>) => Promise<T>;
  /**
   * One step of the workflow, in the queue: the workflow read, `input` read off it when it is a
   * `Reading`, the event judged by `next`, its effects interpreted, the page told. A refused
   * event writes nothing but its journal line.
   */
  readonly dispatch: (
    event: string,
    input: EventInput | Reading,
    actor: Actor,
  ) => Promise<Dispatched>;
  /** The workflow as it stands: the directory, `plan.md`, each extension's region. */
  readonly workflow: () => Promise<Workflow>;
  /** What a step handed the call `call`, `null` while none did: a waiting tool's answer. */
  readonly returned: (call: string) => Returned | null;
  /** The page's unsent work as it was last saved; `null` when there is none, or none it can read. */
  readonly draft: () => Promise<Draft | null>;
  /**
   * What the extension `id` tells Claude of what `input` starts, read by the caller's `Reading`:
   * `step`'s answer carries the grill's opening sentence this way. It judges and writes nothing:
   * the table judges, and the started extension's reaction writes.
   */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- `input` crosses the core from one extension to another, typed in neither's terms here; the started extension's `parse.ts` is the boundary that reads it.
  readonly start: (id: string, input: unknown) => Promise<string>;
  /**
   * Holds a request while `waiting` says what `read` answers still waits, reading again at each
   * `wake`, and answers the last read after `WAIT_HOLD_MS` at most: the engine cuts every
   * `$.http.fetch` at 30 s. A tool that waits for the reviewer is answered this way.
   */
  readonly hold: <T>(read: () => Promise<T>, waiting: (value: T) => boolean) => Promise<T>;
};

/**
 * An extension's part of a Send, read and decided before anything is written: none; questions no
 * answer takes, which the reviewer did not agree to leave to their recommendation (every one of
 * them, so the page asks about all); or its text, what the draft keeps of its typing, and what
 * the Send's event carries for the extension's reaction, under its id.
 */
export type Part =
  | { readonly kind: "none" }
  | { readonly kind: "unanswered"; readonly ids: readonly string[] }
  | {
      readonly kind: "part";
      /** Heading included, written into the batch before the comments. */
      readonly text: string;
      readonly typed: (typed: Typed) => Typed;
      readonly input: string;
    };

/**
 * What the proof of the table (`extensions/proof.ts`) reads of a part's region, from the part's
 * own `walk.ts`, which the runtime never loads: where a walk starts, what tells two regions
 * apart, where it stops, the call an open wait is for and the event that answers it, and what
 * must hold of the workflow wherever the walk goes.
 */
export type WalkOf = {
  /** The region with no file written. */
  readonly empty: Region;
  /** What the invariants tell apart in the region, the counters they never read left out, so the walk ends. */
  readonly key: (region: Region) => string;
  /** Whether the region stays inside the walk's bounds; with none, every region does. */
  readonly bounded?: (region: Region) => boolean;
  /** The call the region's open wait is for: a proposal's id, the open round. */
  readonly call?: (region: Region) => string;
  /** Whether an event the table allowed answers that wait. */
  readonly answers?: (event: string, input: EventInput) => boolean;
  /** What must hold of every workflow the walk reaches, by name: `true` when it is broken. */
  readonly invariants?: { readonly [name: string]: (w: Workflow) => boolean };
};

/** What an extension brings to the workflow: its part of the table, its region, its segment of the band. */
export type ServerWorkflow = TablePart & {
  /**
   * Its region as its files say it; `before` is the one the server's last step left, for what the
   * server remembers and the disk does not say (a proposal's wait), `null` after a start.
   */
  readonly region: (context: ServerContext, before: Region | null) => Promise<Region>;
  readonly segment: (region: Region) => string | null;
  /** Its line in the workflow's view, which `mcp__vellum__state` prints. */
  readonly line: (region: Region) => string;
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
  /** Its region, events, rows, transitions and reaction: what it holds, and what it allows. */
  readonly workflow?: ServerWorkflow;
  /**
   * What Claude is told of what another extension's route starts through `ServerContext.start`:
   * `input` is parsed here. It judges and writes nothing.
   */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- `input` comes from another extension through the core; this extension's `parse.ts` is the boundary that reads it.
  readonly start?: (context: ServerContext, input: unknown) => Promise<string>;
  /**
   * Its part of the bar's Send, in the Send's step of the queue, and never of a Send now. It
   * writes nothing: the Send's event carries its `input`, and its reaction writes.
   */
  readonly part?: (
    context: ServerContext,
    draft: Draft,
    takeDefaults: readonly string[],
  ) => Promise<Part>;
};

/** A page slot a slice's page half may fill: the places `PageExtension` offers. */
export type PageSlot = Exclude<keyof PageExtension, "id">;

/** What a slice's `page.tsx` fills: every slot its plugs declare, and no other. */
export type PageHalf<P extends Plugs> = { readonly id: P["id"] } & {
  readonly [Slot in P["page"]]-?: NonNullable<PageExtension[Slot]>;
} & { readonly [Slot in Exclude<PageSlot, P["page"]>]?: never };

/**
 * A refusal as a slice's route answers it: 400 and 404 in plain text, 409 as `{ error }`. A row
 * refuses with 404 or 409; 400 is a route's own, for a request its parser let through that the
 * server's domain turns down.
 */
export type Refusal = { readonly status: 400 | RefusalStatus; readonly reason: string };

/**
 * A verdict as a slice reads it: a refusal carries the status its row declares, 409 for a row the
 * slice does not own (the core's, another slice's).
 */
export type SliceVerdict =
  | { readonly kind: "allow" }
  | {
      readonly kind: "refuse" | "confirm";
      readonly rule: string;
      readonly status: RefusalStatus;
      readonly reason: string;
    };

export type SliceDispatched = Omit<Dispatched, "verdict"> & { readonly verdict: SliceVerdict };

/**
 * A slice's `ServerContext`. `dispatch` takes only its own events, each with what it carries, sent
 * as its declared sender, named at the call when the event has several. `start` opens another
 * slice with what that slice's contract says opens it, its plugs given as the type argument
 * (`start<GrillPlugs>("grill", { subject })`): without one, no id compiles.
 */
export type SliceContext<P extends Plugs> = Omit<ServerContext, "dispatch" | "start"> & {
  readonly dispatch: <K extends keyof P["events"] & string>(
    event: K,
    input: Sent<P["events"], K> | ((w: Workflow) => Promise<Sent<P["events"], K>>),
    ...by: Sender<P["events"], K>
  ) => Promise<SliceDispatched>;
  readonly start: <Q extends Plugs = never>(id: Q["id"], input: Q["opened"]) => Promise<string>;
};

/**
 * A route's answer: the one its plugs declare, `null` answered as 204; or a refusal, a verdict's
 * or the route's own. An input its parser refuses is answered 400 before the route runs.
 */
export type Reply<A> = { readonly answer: A } | { readonly refused: Refusal };

/** One handler per route the plugs declare: a POST's takes its body, a GET's its query, parsed. */
export type Handlers<P extends Plugs> = {
  readonly [Key in keyof P["server"]]: [InputOf<P["server"], Key>] extends [never]
    ? (context: SliceContext<P>) => Promise<Reply<AnswerOf<P["server"], Key>>>
    : (
        context: SliceContext<P>,
        input: InputOf<P["server"], Key>,
      ) => Promise<Reply<AnswerOf<P["server"], Key>>>;
};

/** One parser per route that reads its request, a POST's body or a GET's query: the boundary, in the slice's `parse.ts`. */
export type Bodies<S> = { readonly [Key in ReadingOf<S>]: Parser<InputOf<S, Key>> };

/** A slice's part of the table, as `tablePart` reads it, with its region and its words. */
export type SliceWorkflow<E extends Events, H extends Heard> = SlicePart<E, H> &
  Omit<ServerWorkflow, keyof TablePart>;

/** A slice's part of the bar's Send: a `Part` whose `input` is the value its reaction to `send` reads back, serialized by the core. */
export type SendPart<T> =
  | Exclude<Part, { readonly kind: "part" }>
  | (Omit<Extract<Part, { readonly kind: "part" }>, "input"> & { readonly input: T });

/** What opens the slice from another's route, when its plugs say something does: the input parsed, then what Claude is told of it. */
type Opening<P extends Plugs> = [P["opened"]] extends [never]
  ? { readonly opened?: never; readonly start?: never }
  : {
      readonly opened: Parser<P["opened"]>;
      readonly start: (context: SliceContext<P>, input: P["opened"]) => Promise<string>;
    };

/** Its part of the bar's Send, when its plugs say it carries one. */
type Sending<P extends Plugs> = [P["sends"]] extends [never]
  ? { readonly part?: never }
  : {
      readonly part: (
        context: SliceContext<P>,
        draft: Draft,
        takeDefaults: readonly string[],
      ) => Promise<SendPart<P["sends"]>>;
    };

/**
 * What a slice's `server.ts` fills: a parser and a handler per route its plugs declare, its part
 * of the workflow, what opens it and its part of the Send when its plugs say so.
 */
export type ServerHalf<P extends Plugs> = {
  readonly id: P["id"];
  readonly bodies: Bodies<P["server"]>;
  readonly routes: Handlers<P>;
  readonly workflow: SliceWorkflow<P["events"], P["hears"]>;
} & Opening<P> &
  Sending<P>;

/** A `SliceContext` with its plugs forgotten, as `serverExtension` builds it. */
export type ErasedSliceContext = Omit<ServerContext, "dispatch"> & {
  readonly dispatch: (
    event: string,
    input: EventInput | Reading,
    by?: Actor,
  ) => Promise<SliceDispatched>;
};

/** What opens a slice and its part of the Send, with its plugs forgotten. */
export type ErasedServerParts = {
  readonly opened?: Parser<Json>;
  readonly start?: (context: ErasedSliceContext, input: never) => Promise<string>;
  readonly part?: (
    context: ErasedSliceContext,
    draft: Draft,
    takeDefaults: readonly string[],
  ) => Promise<SendPart<Json>>;
};

/** A route of any slice: `body` is what that route's own parser answered, and nothing else. */
export type ErasedHandler = (context: ErasedSliceContext, body: never) => Promise<Reply<Json>>;
