import type { OtherKind } from "./choice.ts";
import type { Move } from "./protocol.ts";

export const KIND_LABELS: Readonly<Record<OtherKind, string>> = {
  grill: "Grill",
  mockup: "Mockup",
  prototype: "Prototype",
  plan: "Plan",
  own: "In my words",
};

export const FIELD_HINTS: Readonly<Record<Exclude<OtherKind, "plan">, string>> = {
  grill: "What should Claude grill you on?",
  mockup: "Which screen should Claude draw?",
  prototype: "What should the prototype answer?",
  own: "What should Claude do next?",
};

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
