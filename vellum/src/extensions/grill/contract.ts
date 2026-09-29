import type { ProjectPath } from "../../core/server/domain/paths.ts";
import type { CoreHeard } from "../../core/server/domain/rows.ts";
import { allOf, events, rows } from "../../core/server/domain/rows.ts";
import type { StepEvents } from "../step/contract.ts";
import {
  grillIsOpen,
  namesNoSubject,
  noGrillIsOpen,
  opensAGrill,
  openTranscript,
} from "./grill.ts";
import { NO_GRILL_OPEN } from "./parse.ts";

/**
 * The grill: a transcript the reviewer opens on a subject, where Claude asks rounds of questions
 * and the reviewer answers them with the bar's Send, until End grill or the approval closes it.
 * Other folders import this file and nothing else of the folder. The hooks module and the page
 * read it as types: its values, the events and the rows, are the server's.
 */

// The wire: what crosses `/api/x/grill/*` between the hooks module, the server and the page.

export type Question = { readonly title: string; readonly ask: string; readonly rec: string };

/**
 * Where an open grill stands, read off its file: a question waits for the reviewer, and Claude's
 * call with it (`asking`) or no longer, the turn that asked it cut short (`paused`); the reviewer
 * spoke last (`working`); or Claude did, its turn ended on its answer (`idle`) or cut short,
 * aborted, refused or failed (`stopped`).
 */
export type Phase = "working" | "asking" | "paused" | "idle" | "stopped";

export type GrillState =
  | { readonly kind: "none" }
  | {
      readonly kind: "open";
      readonly file: ProjectPath;
      readonly subject: string;
      readonly phase: Phase;
    };

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

/** The numbers the questions took, which run across the whole grill, and its file. */
export type Asked = { readonly first: number; readonly last: number; readonly file: string };

/**
 * The Send that closed the round, its entry's number and the text `grill_ask` returns; the round
 * closed without one (End grill, the approval), whose answers reach Claude through the channel;
 * or the round still open once the hold ran out.
 */
export type Waited =
  | { readonly kind: "answered"; readonly seq: number; readonly text: string }
  | { readonly kind: "ended" }
  | { readonly kind: "open" };

/** The main loop's final text, why the turn ended, whether a vellum relay started it, and whether it asked a round, whose text it goes with. */
export type TurnAnswer = {
  readonly text: string;
  readonly reason: string;
  readonly own: boolean;
  readonly asked: boolean;
};

/** What the reviewer typed on the open transcript, as the draft keeps it: answers by question id, and the note. */
export type Typing = { readonly answers: Readonly<Record<string, string>>; readonly note: string };

// Who sends each event, and what it carries; the events of the others the grill hears.

export const EVENTS = events({
  openGrill: { by: ["reviewer"], carries: ["subject"] },
  askQuestion: { by: ["claude"], carries: ["q"] },
  turnAnswered: { by: ["engine"], carries: ["text", "reason", "own", "asked"] },
  sessionEvent: { by: ["engine"], carries: ["command"] },
  endGrill: { by: ["reviewer", "engine"], carries: ["reason", "grill"] },
});

export type GrillEvents = typeof EVENTS;

/**
 * The step's answer, which opens a grill on a grill move; the core's Send, whose part closes the
 * round; the core's approval, which closes the grill.
 */
export type GrillHears = Pick<StepEvents, "answerProposal"> & CoreHeard<"send" | "approve">;

// The plugs: where the grill plugs in.

export type GrillPlugs = {
  readonly id: "grill";
  readonly hooks: {
    readonly tools: "grill_ask";
    readonly listens: "prompted" | "answered" | "closing";
    readonly posts: "POST ask" | "POST wait" | "POST event" | "POST answer" | "POST close";
    /** The terminal's question tool: the page is the reviewer's one channel while live. */
    readonly denies: "AskUserQuestion";
  };
  readonly server: {
    readonly "GET state": { readonly answer: GrillState };
    /** A transcript's blocks, by its name: a name that is none answers 404. */
    readonly "GET blocks": {
      readonly query: { readonly file: string | null };
      readonly answer: readonly Block[];
    };
    /** End grill, from the page (what it saved goes as the reply) or `/vellum:stop`. */
    readonly "POST close": {
      readonly body: { readonly reason: CloseReason };
      readonly answer: null;
    };
    readonly "POST ask": {
      readonly body: { readonly q: readonly QuestionTriple[] };
      readonly answer: Asked;
    };
    /** Held until the round whose first question is `first` closes, or for the hold at most. */
    readonly "POST wait": {
      readonly body: { readonly file: string; readonly first: number };
      readonly answer: Waited;
    };
    /** A command of the session (`/vellum:start`, `/clear`): the harness's, written as an event. */
    readonly "POST event": { readonly body: { readonly command: string }; readonly answer: null };
    readonly "POST answer": { readonly body: TurnAnswer; readonly answer: null };
  };
  readonly events: GrillEvents;
  readonly hears: GrillHears;
  /** What the step's answer hands `start`: the subject the grill opens on. */
  readonly opened: { readonly subject: string };
  /** What its part of the bar's Send carries to its reaction: the reply typed on the open transcript. */
  readonly sends: Typing;
  readonly page: "renderers" | "notices" | "send" | "panel";
};

// What is refused, read top to bottom per event, with the status its route answers.

const NOT_A_SUBJECT = "a grill's subject is one line, not empty";

const { refuse, refuseInput, refuseHeard, refuseInputHeard } = rows<GrillEvents, GrillHears>(
  EVENTS,
);

export const RULES = [
  refuseInput("openGrill", "grill-subject", namesNoSubject, 409, NOT_A_SUBJECT),
  refuse("openGrill", "grill-open", grillIsOpen, 409, openTranscript),
  refuseInputHeard(
    "answerProposal",
    "grill-subject",
    allOf(opensAGrill, namesNoSubject),
    409,
    NOT_A_SUBJECT,
  ),
  refuseHeard("answerProposal", "grill-open", allOf(opensAGrill, grillIsOpen), 409, openTranscript),
  refuse("askQuestion", "no-grill", noGrillIsOpen, 409, NO_GRILL_OPEN),
];
