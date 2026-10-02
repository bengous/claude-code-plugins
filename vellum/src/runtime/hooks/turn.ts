/**
 * Whose turn runs: the one thing the module knows that the server does not. `turn.start`
 * carries no origin, so `session.append` notes each prompt row the engine keeps before a turn,
 * its text and whether vellum relayed it, and the turn that starts on that text takes it. Two
 * facts that coexist, since a row may be kept while a turn still runs.
 * Neither is a variant of the mode's `State`: they say who started a turn, nothing about what
 * is allowed.
 *
 * Every miss falls on one side, a turn read as not vellum's, whose text is written nowhere: two
 * rows before one turn are vellum's only if both are, a turn whose text does not hold the last
 * row's is nobody's, and a reload between the row and its turn loses the note.
 */
type Noted =
  | { readonly kind: "none" }
  | { readonly kind: "prompt"; readonly text: string; readonly own: boolean };

type Running =
  | { readonly kind: "none" }
  | { readonly kind: "turn"; readonly turnId: string; readonly own: boolean };

export type Turns = { readonly noted: Noted; readonly running: Running };

export const NO_TURN: Turns = { noted: { kind: "none" }, running: { kind: "none" } };

/** `session.append` of a prompt row: the next turn's note; the turn that runs is left as it is. */
export function prompted(turns: Turns, text: string, own: boolean): Turns {
  const { noted } = turns;
  const all = noted.kind === "prompt" ? noted.own && own : own;

  return { ...turns, noted: { kind: "prompt", text, own: all } };
}

/**
 * `turn.start`, which takes the note. The turn's text is the row's as measured, framed by the
 * engine for a plugin's prompt; `includes` keeps a turn that adds to it. An empty note matches
 * nothing, so a continuation, whose text is empty, never takes a note left behind.
 */
export function started(turns: Turns, text: string, turnId: string): Turns {
  const { noted } = turns;

  const own =
    noted.kind === "prompt" && noted.own && noted.text !== "" && text.includes(noted.text);

  return { noted: { kind: "none" }, running: { kind: "turn", turnId, own } };
}

export function ownOf(turns: Turns, turnId: string): boolean {
  const { running } = turns;

  return running.kind === "turn" && running.turnId === turnId && running.own;
}

/**
 * A tool call of the running turn returned an entry of the reviewer's, as a waiting tool's
 * result: the reviewer spoke into the turn, so what Claude says next answers them.
 */
export function replied(turns: Turns): Turns {
  const { running } = turns;

  return running.kind === "turn" ? { ...turns, running: { ...running, own: true } } : turns;
}

/** `turn.complete` of the running turn; the end of any other one changes nothing. */
export function completed(turns: Turns, turnId: string): Turns {
  const { running } = turns;

  return running.kind === "turn" && running.turnId === turnId
    ? { ...turns, running: { kind: "none" } }
    : turns;
}
