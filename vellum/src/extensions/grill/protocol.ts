import type { ProjectPath } from "../../core/server/domain/paths.ts";

/** What crosses `/api/x/grill/*` between the hooks module, the server and the page; JSON. */

export type Question = { readonly title: string; readonly ask: string; readonly rec: string };

export type Suggestion = { readonly subject: string; readonly reason: string };

/** An entry of the reviewer Claude has not answered: `round` 0 is the opening, `n` their nth reply. What the engine relays, once. */
export type ReviewerRound = {
  readonly file: ProjectPath;
  readonly round: number;
  readonly text: string;
};

export type GrillState =
  | {
      readonly kind: "none";
      readonly suggestion: Suggestion | null;
      /** The last grill of the directory, closed: the engine tells Claude of an end it did not cause. */
      readonly closed: { readonly file: ProjectPath; readonly reason: string } | null;
    }
  | {
      readonly kind: "open";
      readonly file: ProjectPath;
      readonly subject: string;
      readonly phase: "working" | "waiting";
      /** The reviewer's last entry; `null` once Claude answered under it. */
      readonly reviewer: ReviewerRound | null;
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

export type CloseReason = "page" | "stop" | "approved";

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
  /** The main loop's final text, and why the turn ended. */
  readonly answer: { readonly text: string; readonly reason: string };
};
