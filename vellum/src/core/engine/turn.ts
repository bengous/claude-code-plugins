/**
 * Whose turn runs: the one thing the module knows that the server does not. `turn.start`
 * carries no origin, so `prompt.submit` notes the last prompt that entered, and the turn that
 * starts on that text takes its origin. Two facts that coexist, since a prompt may enter while
 * a turn runs. Neither is a variant of the mode's `State`: they say who started a turn, nothing
 * about what is allowed.
 *
 * One note, never a registry: a text identifies a prompt, not a submission. So a relay and a
 * typed prompt that wait together leave one note, the last one, and the relay's turn reads as
 * not vellum's. A reload loses both facts the same way. Every miss falls on one side: the
 * turn's text is written nowhere.
 */
type Noted =
  | { readonly kind: "none" }
  | { readonly kind: "prompt"; readonly text: string; readonly own: boolean };

type Running =
  | { readonly kind: "none" }
  | { readonly kind: "turn"; readonly turnId: string; readonly own: boolean };

export type Turns = { readonly noted: Noted; readonly running: Running };

export const NO_TURN: Turns = { noted: { kind: "none" }, running: { kind: "none" } };

/** `prompt.submit`: the last prompt that entered; the turn that runs is left as it is. */
export function prompted(turns: Turns, text: string, own: boolean): Turns {
  return { ...turns, noted: { kind: "prompt", text, own } };
}

/**
 * `turn.start`, which takes the note. The turn's text holds the noted one rather than equals
 * it: how the engine frames a plugin's prompt there is not measured, and an equality that never
 * holds would switch `own` off in silence. An empty note matches nothing.
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

/** `turn.complete` of the running turn; the end of any other one changes nothing. */
export function completed(turns: Turns, turnId: string): Turns {
  const { running } = turns;

  return running.kind === "turn" && running.turnId === turnId
    ? { ...turns, running: { kind: "none" } }
    : turns;
}
