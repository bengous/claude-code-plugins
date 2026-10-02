/**
 * Whose turn runs: the one thing the module knows that the server does not. `turn.start`
 * carries no origin, so `session.append` notes the origin of the last prompt row kept, which
 * the engine keeps just before the turn that prompt starts, and that turn takes it. Two facts
 * that coexist, since a turn runs while the next prompt waits. Neither is a variant of the
 * mode's `State`: they say who started a turn, nothing about what is allowed.
 *
 * A reload between the row and its turn loses the note, and that turn reads as not vellum's:
 * the turn's text is written nowhere.
 */
type Noted = { readonly kind: "none" } | { readonly kind: "prompt"; readonly own: boolean };

type Running =
  | { readonly kind: "none" }
  | { readonly kind: "turn"; readonly turnId: string; readonly own: boolean };

export type Turns = { readonly noted: Noted; readonly running: Running };

export const NO_TURN: Turns = { noted: { kind: "none" }, running: { kind: "none" } };

/** `session.append` of a prompt row: the next turn's origin; the turn that runs is left as it is. */
export function prompted(turns: Turns, own: boolean): Turns {
  return { ...turns, noted: { kind: "prompt", own } };
}

/** `turn.start`, which takes the note: a turn with none before it is not vellum's. */
export function started(turns: Turns, turnId: string): Turns {
  const own = turns.noted.kind === "prompt" && turns.noted.own;

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
