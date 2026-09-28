import type { Listen } from "./engine/extension.ts";
import type { PageSlot } from "./extension.ts";
import type { Events, Heard } from "./server/domain/rows.ts";

/**
 * What a slice's `contract.ts` declares, and what its halves are typed by: its id, the tools, the
 * engine events, the routes and the tools denied of its hooks half, each route of its server half
 * with what it takes and what it answers, the workflow events it owns and those it hears, what
 * opens it and what its part of a Send carries, and the page slots its page half fills. Types
 * only: the hooks module, the server and the page each read it.
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
