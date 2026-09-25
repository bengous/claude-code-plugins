import type { Move, StepAnswer } from "./protocol.ts";

/** What "Something else…" takes: a step of any kind with the reviewer's own subject, or their own words. */
export type OtherKind = Move["kind"] | "own";

/** What the reviewer picked in the "Next step" window: nothing yet, a move offered, or their own. */
export type Pick =
  | { readonly kind: "none" }
  | { readonly kind: "move"; readonly index: number }
  | { readonly kind: "other"; readonly other: OtherKind; readonly text: string };

export const NO_PICK: Pick = { kind: "none" };

/** The window opened blank: a step of the reviewer's own, a grill until they pick another kind. */
export const OWN_GRILL: Pick = { kind: "other", other: "grill", text: "" };

/** Every break a line reader cuts at becomes one space: a grill's subject is its transcript's header. */
export function oneLine(text: string): string {
  return text.replaceAll(/\s*[\n\r\u2028\u2029]\s*/gu, " ");
}

/** What a pick sends; `null` while nothing is picked, or while the text it needs is empty. */
export function answerOf(pick: Pick, moves: readonly Move[]): StepAnswer | null {
  if (pick.kind === "none") return null;

  if (pick.kind === "move") {
    const move = moves[pick.index];

    return move === undefined ? null : { kind: "move", move };
  }

  if (pick.other === "plan") return { kind: "move", move: { kind: "plan" } };

  if (pick.other === "own") {
    const own = pick.text.trim();

    return own === "" ? null : { kind: "own", text: own };
  }

  const line = oneLine(pick.text).trim();

  if (line === "") return null;

  switch (pick.other) {
    case "grill":
      return { kind: "move", move: { kind: "grill", subject: line, choices: [] } };
    case "mockup":
      return { kind: "move", move: { kind: "mockup", screen: line } };
    case "prototype":
      return { kind: "move", move: { kind: "prototype", question: line } };
  }
}
