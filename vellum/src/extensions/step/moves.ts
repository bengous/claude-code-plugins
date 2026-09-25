import type { Move, Pending, StepAnswer } from "./protocol.ts";

/** A move as Claude reads it in the reviewer's answer. */
export function moveText(move: Move): string {
  switch (move.kind) {
    case "grill":
      return `a grill on: ${move.subject}`;
    case "mockup":
      return `a mockup of: ${move.screen}`;
    case "prototype":
      return `a prototype for: ${move.question}`;
    case "plan":
      return "the plan";
  }
}

export function sameMove(one: Move, other: Move): boolean {
  switch (one.kind) {
    case "grill":
      return (
        other.kind === "grill" &&
        one.subject === other.subject &&
        one.choices.length === other.choices.length &&
        one.choices.every((choice, index) => choice === other.choices[index])
      );
    case "mockup":
      return other.kind === "mockup" && one.screen === other.screen;
    case "prototype":
      return other.kind === "prototype" && one.question === other.question;
    case "plan":
      return other.kind === "plan";
  }
}

/** A text closed by a period, unless it already ends a sentence: a subject is often a question. */
function sentence(text: string): string {
  return /[.!?…]$/u.test(text) ? text : `${text}.`;
}

/**
 * What Claude is told of the reviewer's answer: `Accepted` for the move it recommended, `Chose`
 * for any other, one it offered or one of the reviewer's own, `Own` for the reviewer's words.
 */
export function answerText(answer: StepAnswer, pending: Pending | null): string {
  if (answer.kind === "own") return sentence(`Own: ${answer.text}`);
  const recommended = pending?.proposal.moves[pending.proposal.recommended];
  const accepted = recommended !== undefined && sameMove(answer.move, recommended);

  return sentence(`${accepted ? "Accepted" : "Chose"}: ${moveText(answer.move)}`);
}
