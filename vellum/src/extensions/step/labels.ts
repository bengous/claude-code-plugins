import type { OtherKind } from "./choice.ts";
import type { Move } from "./protocol.ts";

/** A kind of step as the window names it, the reviewer's own words included. */
export const KIND_LABELS: Readonly<Record<OtherKind, string>> = {
  grill: "Grill",
  mockup: "Mockup",
  prototype: "Prototype",
  plan: "Plan",
  own: "In my words",
};

/** What the field asks for a step of the reviewer's own; the plan takes no text. */
export const FIELD_HINTS: Readonly<Record<Exclude<OtherKind, "plan">, string>> = {
  grill: "What should Claude grill you on?",
  mockup: "Which screen should Claude draw?",
  prototype: "What should the prototype answer?",
  own: "What should Claude do next?",
};

/** What a move is about, under its kind: its subject, its screen or its question. */
export function detailOf(move: Move): string {
  switch (move.kind) {
    case "grill":
      return move.subject;
    case "mockup":
      return move.screen;
    case "prototype":
      return move.question;
    case "plan":
      return "Write the plan now";
  }
}

/** What an answer that failed says: `status` `null` when the server did not answer, `error` the one it gave. */
export function answerFailure(status: number | null, error: string | null): string {
  if (status === null)
    return "The step did not reach the server: it waits on the Next step button.";

  if (status === 409 && error === "no such proposal") {
    return "Claude's proposal was already answered or replaced.";
  }

  return error === null
    ? `The step was refused: the server answered ${status}.`
    : `The step was refused: ${error}.`;
}
