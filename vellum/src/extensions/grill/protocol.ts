import type { ProjectPath } from "../../core/server/domain/paths.ts";

/** What crosses `/api/x/grill/*` between the hooks module, the server and the page; JSON. */

export type Question = { readonly title: string; readonly ask: string; readonly rec: string };

export type Suggestion = { readonly subject: string; readonly reason: string };

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
      readonly suggestion: Suggestion | null;
      readonly relays: readonly Relay[];
    }
  | {
      readonly kind: "open";
      readonly file: ProjectPath;
      readonly subject: string;
      readonly phase: "working" | "waiting";
      readonly relays: readonly Relay[];
    };

/**
 * What the page draws. A question crosses as data, never as rendered Markdown: the page draws a
 * card with its number, its topic, the recommendation, and its answer or its field. The `❓`
 * and `➡️` markers stay in the file, where they carry the parsing, and the page never prints them.
 */
export type Block =
  | { readonly kind: "html"; readonly html: string }
  | {
      readonly kind: "question";
      /** `Q3`, the number that runs across the whole grill. */
      readonly id: string;
      readonly title: string;
      readonly ask: string;
      readonly rec: string;
      /** The reviewer's answer, read beside its question; `null` while the card takes one. */
      readonly answer: string | null;
    };

/** Who ended a grill from outside the approval: the reviewer in the page, or `/vellum:stop`. The approval's footer is the server's own. */
export type CloseReason = "page" | "stop";

/** A question as the tool and the route take it: `[title, question, recommendation]`. */
export type QuestionTriple = readonly [title: string, ask: string, rec: string];

/** What `POST ask` answers: the numbers the questions took, which run across the whole grill. */
export type Asked = { readonly first: number; readonly last: number };

/** The body each `POST /api/x/grill/<name>` takes, by route name. */
export type GrillPosts = {
  readonly open: { readonly subject: string };
  readonly close: { readonly reason: CloseReason };
  readonly ask: { readonly q: readonly QuestionTriple[] };
  readonly suggest: Suggestion;
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
