import type { Listen } from "./engine/extension.ts";
import type { PageSlot } from "./extension.ts";
import type { Events } from "./server/domain/rows.ts";

/**
 * What a slice's `contract.ts` declares, and what its halves are typed by: its id, the tools and
 * the engine events its hooks half takes, each route of its server half with the body it takes
 * and the answer it gives, the workflow events it owns, and the page slots its page half fills.
 * Types only: the hooks module, the server and the page each read it.
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

/** A GET takes no body; a POST takes one; both answer. */
export type Routes = {
  readonly [Route in GetRoute]: { readonly body?: never; readonly answer: Json };
} & {
  readonly [Route in PostRoute]: { readonly body: Json; readonly answer: Json };
};

export type Plugs = {
  /** The folder's name: its routes are mounted under `/api/x/<id>/`. */
  readonly id: string;
  /** The tools the hooks half registers, the engine events it listens to, the routes it posts. */
  readonly hooks: { readonly tools: string; readonly listens: Listen; readonly posts: PostRoute };
  readonly server: Routes;
  readonly events: Events;
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

/** The answer `S` declares for `Route`; `never` for a route `S` does not declare. */
export type AnswerOf<S, Route> = Route extends keyof S
  ? S[Route] extends { readonly answer: infer Answer extends Json }
    ? Answer
    : never
  : never;

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a parser is the boundary itself: it takes what arrives unread, a request's body or a reply, and answers the type or `null`.
export type Parser<T> = (value: unknown) => T | null;
