import type { ProjectPath } from "../../core/server/domain/paths.ts";

/** What crosses `/api/x/grill/*` between the hooks module, the server and the page; JSON. */

/** The tool Claude asks a round with: the engine half serves it, the server names it to Claude. */
export const ASK_TOOL = "mcp__vellum__grill_ask";

export type Question = { readonly title: string; readonly ask: string; readonly rec: string };

/**
 * Where an open grill stands, read off its file: a question waits for the reviewer (`asking`),
 * the reviewer spoke last (`working`), or Claude did, its turn ended on its answer (`idle`) or
 * cut short, aborted, refused or failed (`stopped`).
 */
export type Phase = "working" | "asking" | "idle" | "stopped";

export type GrillState =
  | { readonly kind: "none" }
  | {
      readonly kind: "open";
      readonly file: ProjectPath;
      readonly subject: string;
      readonly phase: Phase;
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

/** What `POST ask` answers: the numbers the questions took, which run across the whole grill, and its file. */
export type Asked = { readonly first: number; readonly last: number; readonly file: string };

/**
 * What `POST wait` answers: the Send that closed the round, its entry's number and the text
 * `grill_ask` returns; the round closed without one (End grill, the approval), whose answers reach
 * Claude through the channel; or the round still open once the hold ran out.
 */
export type Waited =
  | { readonly kind: "answered"; readonly seq: number; readonly text: string }
  | { readonly kind: "ended" }
  | { readonly kind: "open" };

/** The body each `POST /api/x/grill/<name>` takes, by route name. */
export type GrillPosts = {
  readonly close: { readonly reason: CloseReason };
  readonly ask: { readonly q: readonly QuestionTriple[] };
  /** Held until the round whose first question is `first` closes, or for the hold at most. */
  readonly wait: { readonly file: string; readonly first: number };
  /** A command of the session (`/vellum:start`, `/clear`): the harness's, written as an event. */
  readonly event: { readonly command: string };
  /**
   * The main loop's final text, why the turn ended, whether a vellum relay started it, and
   * whether it asked a round: that round's text, which goes with it.
   */
  readonly answer: {
    readonly text: string;
    readonly reason: string;
    readonly own: boolean;
    readonly asked: boolean;
  };
};
