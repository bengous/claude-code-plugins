import type { Listen } from "./engine/extension.ts";
import type { PageSlot } from "./extension.ts";
import type { CoreEvent, Events, Heard } from "./server/domain/rows.ts";

/**
 * What a slice's `contract.ts` declares, and what its halves are typed by: its id, the tools, the
 * engine events, the routes and the tools denied of its hooks half, each route of its server half
 * with what it takes and what it answers, the workflow events it owns and those it hears, what
 * opens it and what its part of a Send carries, and the page slots its page half fills. A contract
 * writes it once, as `defineSlice({...})`, and takes its plugs by `PlugsOf<typeof SLICE>`: what it
 * leaves out it does not declare. The hooks module and the page read the plugs as types; the
 * declaration itself, a value, is the server's and the tests'.
 */

/** What crosses a route as JSON, so `Response.json` and `JSON.parse` lose nothing on the way. */
export type Json =
  | string
  | number
  | boolean
  | null
  | readonly Json[]
  | { readonly [key: string]: Json };

export type GetRoute = `GET ${string}`;

export type PostRoute = `POST ${string}`;

/** A GET takes no body, and may read a query; a POST takes a body; both answer. */
export type Routes = {
  readonly [Route in GetRoute]: {
    readonly query?: { readonly [param: string]: string | null };
    readonly body?: never;
    readonly answer: Json;
  };
} & {
  readonly [Route in PostRoute]: { readonly body: Json; readonly answer: Json };
};

export type Plugs = {
  /** The folder's name: its routes are mounted under `/api/x/<id>/`. */
  readonly id: string;
  /**
   * The tools the hooks half registers, the engine events it listens to, the routes it posts, and
   * the engine's tools it denies while the mode is live (`never` for none).
   */
  readonly hooks: {
    readonly tools: string;
    readonly listens: Listen;
    readonly posts: PostRoute;
    readonly denies: string;
  };
  readonly server: Routes;
  readonly events: Events;
  /** The events of the others it judges or reacts to: another slice's, as its contract types them, or the core's. */
  readonly hears: Heard;
  /** What another slice hands `ServerContext.start` to open this one; `never` when none does. */
  readonly opened: Json;
  /** What its part of the bar's Send carries to its reaction to `send`; `never` when it has none. */
  readonly sends: Json;
  readonly page: PageSlot;
};

/** The routes of `S` that take a body. */
export type PostOf<S> = Extract<keyof S, PostRoute>;

/** The body `S` declares for `Route`; `never` for a route `S` does not declare. */
export type BodyOf<S, Route> = Route extends keyof S
  ? S[Route] extends { readonly body: infer Body extends Json }
    ? Body
    : never
  : never;

/** The query `S` declares for the GET `Route`; `never` for a route with none. */
export type QueryOf<S, Route> = Route extends keyof S
  ? S[Route] extends { readonly query: infer Query extends Json }
    ? Query
    : never
  : never;

/** What a route reads of its request, parsed: a POST's body, a GET's query; `never` for none. */
export type InputOf<S, Route> = Route extends PostRoute ? BodyOf<S, Route> : QueryOf<S, Route>;

/** The routes of `S` that read their request: every POST, and a GET with a query. */
export type ReadingOf<S> = {
  readonly [Route in keyof S]: [InputOf<S, Route>] extends [never] ? never : Route;
}[keyof S];

/** The answer `S` declares for `Route`; `never` for a route `S` does not declare. */
export type AnswerOf<S, Route> = Route extends keyof S
  ? S[Route] extends { readonly answer: infer Answer extends Json }
    ? Answer
    : never
  : never;

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a parser is the boundary itself: it takes what arrives unread, a request's body or a reply, and answers the type or `null`.
export type Parser<T> = (value: unknown) => T | null;

/**
 * A route as a contract declares it: its method, and what it reads and answers as types alone,
 * carried by `types`, which no value ever sets.
 */
export type RouteDecl<Method extends "GET" | "POST", Input, Answer> = {
  readonly method: Method;
  /** A GET that reads a query, which its parser in `BODIES` reads first. */
  readonly query?: true;
  readonly types?: () => { readonly input: Input; readonly answer: Answer };
};

/** A GET that answers `A`. */
export function get<A extends Json>(): RouteDecl<"GET", never, A> {
  return { method: "GET" };
}

/** A GET that reads the query `Q` and answers `A`. */
export function getWith<
  Q extends { readonly [param: string]: string | null },
  A extends Json,
>(): RouteDecl<"GET", Q, A> {
  return { method: "GET", query: true };
}

/** A POST that takes the body `B` and answers `A`, `null` for nothing (204). */
export function post<B extends Json, A extends Json>(): RouteDecl<"POST", B, A> {
  return { method: "POST" };
}

/** A value the contract names as a type alone: what opens the slice, what its part of a Send carries. */
export type Payload<T> = { readonly types?: () => T };

export function payload<T extends Json>(): Payload<T> {
  return {};
}

/** An event another slice owns, heard with the fields its contract says it carries. */
export type HeardDecl<Carries extends readonly string[]> = {
  readonly from: "slice";
  readonly types?: () => Carries;
};

/** An event of the core's, heard by name: the core declares no fields. */
export type HeardFromCore = { readonly from: "core" };

/** `heard<StepEvents["answerProposal"]>()`: another slice's event, typed by its contract. */
export function heard<E extends { readonly carries: readonly string[] }>(): HeardDecl<
  E["carries"]
> {
  return { from: "slice" };
}

/** An event of the core's, heard: `hears: { approve: core }`. */
export const core: HeardFromCore = { from: "core" };

type Hears = { readonly [event: string]: HeardDecl<readonly string[]> | HeardFromCore };

/** An event heard from the core must be one the core has. */
type CheckedHears<H> = {
  readonly [Event in keyof H]: H[Event] extends HeardFromCore
    ? Event extends CoreEvent
      ? H[Event]
      : CoreEvent
    : H[Event];
};

export type SliceDecl = {
  /** The folder's name: its routes are mounted under `/api/x/<id>/`. */
  readonly id: string;
  /** Each event it owns: who may send it, and the fields its input carries. */
  readonly events?: Events;
  /** The events of the others it judges or reacts to: another slice's, or the core's. */
  readonly hears?: Hears;
  readonly hooks?: {
    /** The tools its hooks half registers, each as `mcp__vellum__<name>`. */
    readonly tools?: readonly string[];
    /** The engine events its hooks half listens to. */
    readonly listens?: readonly Listen[];
    /** The routes of its own server half its hooks half posts. */
    readonly posts?: readonly PostRoute[];
    /** The engine's tools its hooks half denies while the mode is live. */
    readonly denies?: readonly string[];
  };
  readonly routes?: {
    readonly [Route in GetRoute]?: RouteDecl<"GET", Json, Json>;
  } & { readonly [Route in PostRoute]?: RouteDecl<"POST", Json, Json> };
  /** What another slice hands `ServerContext.start` to open this one. */
  readonly opened?: Payload<Json>;
  /** What its part of the bar's Send carries to its reaction to `send`. */
  readonly sends?: Payload<Json>;
  /** The page slots its page half fills. */
  readonly page?: readonly PageSlot[];
};

/** The declaration as written, its lists and names kept as literals. */
export function defineSlice<const D extends SliceDecl>(
  declared: D & { readonly hears?: CheckedHears<D["hears"]> },
): D {
  return declared;
}

type ListedIn<T, K extends string> = T extends { readonly [Key in K]: readonly (infer Item)[] }
  ? Item
  : never;

type HooksOf<D> = D extends { readonly hooks: infer H } ? H : never;

type RoutesOf<D> = D extends { readonly routes: infer R }
  ? {
      readonly [Route in keyof R]: R[Route] extends RouteDecl<"GET", infer Q, infer A>
        ? [Q] extends [never]
          ? { readonly answer: A }
          : { readonly query: Q; readonly answer: A }
        : R[Route] extends RouteDecl<"POST", infer B, infer A>
          ? { readonly body: B; readonly answer: A }
          : never;
    }
  : Record<never, never>;

type HeardOf<D> = D extends { readonly hears: infer H }
  ? {
      readonly [Event in keyof H]: H[Event] extends HeardDecl<infer Carries>
        ? { readonly carries: Carries }
        : { readonly carries: readonly string[] };
    }
  : Record<never, never>;

type PayloadOf<D, K extends string> = D extends { readonly [Key in K]: Payload<infer T> }
  ? T
  : never;

type EventsOf<D> = D extends { readonly events: infer E extends Events } ? E : Record<never, never>;

/** What a declaration plugs, as its halves are typed by it: `never` where it declares nothing. */
export type PlugsOf<D extends SliceDecl> = {
  readonly id: D["id"];
  readonly hooks: {
    readonly tools: ListedIn<HooksOf<D>, "tools">;
    readonly listens: ListedIn<HooksOf<D>, "listens">;
    readonly posts: ListedIn<HooksOf<D>, "posts">;
    readonly denies: ListedIn<HooksOf<D>, "denies">;
  };
  readonly server: RoutesOf<D>;
  readonly events: EventsOf<D>;
  readonly hears: HeardOf<D>;
  readonly opened: PayloadOf<D, "opened">;
  readonly sends: PayloadOf<D, "sends">;
  readonly page: ListedIn<D, "page">;
};
