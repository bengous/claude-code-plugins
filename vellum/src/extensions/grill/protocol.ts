import type { ProjectPath } from "../../core/server/domain/paths.ts";

/** What crosses `/api/x/grill/*` between the hooks module, the server and the page; JSON. */

export type Question = { readonly title: string; readonly ask: string; readonly rec: string };

/** A proposal of Claude's, under the id the server gave it. */
export type Suggestion = { readonly id: string; readonly subject: string; readonly reason: string };

/** What `grill_suggest` sends; the server gives the id. */
export type Suggested = { readonly subject: string; readonly reason: string };

export type Declined = { readonly id: string; readonly subject: string };

/**
 * The server's one proposal slot: `grill_suggest` fills it, a decline turns it declined, a new
 * proposal replaces either, and opening a grill empties it.
 */
export type Proposal =
  | { readonly kind: "pending"; readonly suggestion: Suggestion }
  | { readonly kind: "declined"; readonly declined: Declined };

/**
 * One entry the engine submits. `seq` runs in file order: 0 the opening, 1..n the reviewer's
 * replies, n+1 the end, told only when the reviewer ended the grill from the page. The text is
 * the agent's, not the file's.
 */
export type Relay =
  | {
      readonly kind: "opened";
      readonly seq: 0;
      readonly name: string;
      readonly subject: string;
    }
  | { readonly kind: "reply"; readonly seq: number; readonly text: string }
  | { readonly kind: "ended"; readonly seq: number; readonly name: string };

/** `relays` are the entries of the last grill past the cursor `GET state` was asked with, in order. */
export type GrillState =
  | {
      readonly kind: "none";
      readonly proposal: Proposal | null;
      readonly relays: readonly Relay[];
    }
  | {
      readonly kind: "open";
      readonly file: ProjectPath;
      readonly subject: string;
      readonly phase: "working" | "waiting";
      readonly relays: readonly Relay[];
    };

/** A reply's answer that takes the recommendation by choice, where an answer left out takes it by default. */
export const AS_RECOMMENDED = "As recommended.";

/** A question's answer as the file holds it: none yet, the recommendation by default or by choice, or the reviewer's own words. */
export type Answer =
  | { readonly kind: "open" }
  | { readonly kind: "default" }
  | { readonly kind: "recommended" }
  | { readonly kind: "typed"; readonly text: string };

/**
 * What the page draws. A question crosses as a card's parts: its number, its round, its topic,
 * the question and the recommendation as HTML the server rendered from the file's Markdown with
 * the same `toHtml` as the text between the cards, and its answer. The `❓` and `➡️` markers
 * stay in the file, where they carry the parsing, and the page never prints them.
 */
export type Block =
  | { readonly kind: "opened"; readonly subject: string; readonly at: string }
  | { readonly kind: "closed"; readonly at: string; readonly reason: CloseReason | "approved" }
  | { readonly kind: "html"; readonly html: string }
  | {
      readonly kind: "question";
      /** `Q3`, the number that runs across the whole grill. */
      readonly id: string;
      /** The `## Round n` it was asked in; 0 for a question Claude typed before the first. */
      readonly round: number;
      readonly title: string;
      /** Inline HTML, never raw Markdown: the page inserts it as it inserts an `html` block. */
      readonly ask: string;
      /** As `ask`; `""` when Claude gave none. */
      readonly rec: string;
      readonly answer: Answer;
    };

/** Who ended a grill from outside the approval: the reviewer in the page, or `/vellum:stop`. The approval's footer is the server's own. */
export type CloseReason = "page" | "stop";

/** A question as the tool and the route take it: `[title, question, recommendation]`. */
export type QuestionTriple = readonly [title: string, ask: string, rec: string];

/** What `POST ask` answers: the numbers the questions took, which run across the whole grill. */
export type Asked = { readonly first: number; readonly last: number };

/** What `POST open` answers: the file the grill was written to, and nothing of its state. */
export type Opened = { readonly file: ProjectPath };

/** The body each `POST /api/x/grill/<name>` takes, by route name. */
export type GrillPosts = {
  readonly open: { readonly subject: string };
  readonly close: { readonly reason: CloseReason };
  readonly ask: { readonly q: readonly QuestionTriple[] };
  readonly suggest: Suggested;
  /** Refused unless `id` names the pending proposal: a tab kept since cannot decline a newer one. */
  readonly decline: { readonly id: string };
  /** Closes every open question: one left out of `answers` takes the recommendation by default. */
  readonly reply: {
    readonly answers: readonly { readonly id: string; readonly text: string }[];
    readonly note: string;
  };
  /** A command of the session (`/vellum:start`, `/clear`): the harness's, written as an event. */
  readonly event: { readonly command: string };
  /** The main loop's final text, why the turn ended, and whether a vellum relay started it. */
  readonly answer: { readonly text: string; readonly reason: string; readonly own: boolean };
};
