import type { ProjectPath } from "../../workshop/paths.ts";
import type { PlugsOf } from "../../workshop/plugs.ts";
import { core, defineSlice, get, getWith, heard, payload, post } from "../../workshop/plugs.ts";
import { rows } from "../../workshop/rows.ts";
import type { StepEvents } from "../proposal/contract.ts";
import { grillIsOpen, namesNoSubject, noGrillIsOpen, openTranscript } from "./grill.ts";
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

// The declaration: the events it owns, those of the others it hears, and where each half plugs in.

export const SLICE = defineSlice({
  id: "grill",
  events: {
    openGrill: { by: ["reviewer"], carries: ["subject"] },
    askQuestion: { by: ["claude"], carries: ["q"] },
    turnAnswered: { by: ["engine"], carries: ["text", "reason", "own", "asked"] },
    sessionEvent: { by: ["engine"], carries: ["command"] },
    endGrill: { by: ["reviewer", "engine"], carries: ["reason", "grill"] },
  },
  /**
   * The step's answer, which opens a grill on a grill move; the core's Send, whose part closes the
   * round; the core's approval, which closes the grill.
   */
  hears: { answerProposal: heard<StepEvents["answerProposal"]>(), send: core, approve: core },
  hooks: {
    tools: ["grill_ask"],
    listens: ["prompted", "answered", "closing"],
    posts: ["POST ask", "POST wait", "POST event", "POST answer", "POST close"],
    /** The terminal's question tool: the page is the reviewer's one channel while live. */
    denies: ["AskUserQuestion"],
  },
  routes: {
    "GET state": get<GrillState>(),
    /** A transcript's blocks, by its name: a name that is none answers 404. */
    "GET blocks": getWith<{ readonly file: string | null }, readonly Block[]>(),
    /** End grill, from the page (what it saved goes as the reply) or `/vellum:stop`. */
    "POST close": post<{ readonly reason: CloseReason }, null>(),
    "POST ask": post<{ readonly q: readonly QuestionTriple[] }, Asked>(),
    /** Held until the round whose first question is `first` closes, or for the hold at most. */
    "POST wait": post<{ readonly file: string; readonly first: number }, Waited>(),
    /** A command of the session (`/vellum:start`, `/clear`): the harness's, written as an event. */
    "POST event": post<{ readonly command: string }, null>(),
    "POST answer": post<TurnAnswer, null>(),
  },
  /** What the step's answer hands `start`: the subject the grill opens on. */
  opened: payload<{ readonly subject: string }>(),
  /** What its part of the bar's Send carries to its reaction: the reply typed on the open transcript. */
  sends: payload<Typing>(),
  page: ["renderers", "notices", "send", "panel"],
});

export type GrillPlugs = PlugsOf<typeof SLICE>;

export type GrillEvents = GrillPlugs["events"];

export type GrillHears = GrillPlugs["hears"];

// What is refused, read top to bottom per event, with the status its route answers.

const NOT_A_SUBJECT = "a grill's subject is one line, not empty";

const { refuse } = rows(SLICE);

export const RULES = [
  refuse("openGrill", "grill-subject", namesNoSubject, 409, NOT_A_SUBJECT),
  refuse("openGrill", "grill-open", grillIsOpen, 409, openTranscript),
  refuse("askQuestion", "no-grill", noGrillIsOpen, 409, NO_GRILL_OPEN),
];
