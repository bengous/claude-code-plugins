import { AS_RECOMMENDED } from "./protocol.ts";
import type { Answer, CloseReason, Phase } from "./protocol.ts";
import type { ChipState } from "./rounds.ts";

/** What the transcript's foot says of its end, in the reviewer's words; the file keeps the reason's code. */
export function footerOf(reason: CloseReason | "approved"): string {
  switch (reason) {
    case "page":
      return "Ended by you";
    case "stop":
      return "Ended by /vellum:stop";
    case "approved":
      return "Ended at approval";
  }
}

/** What the band says after the subject: the round the grill stands in, 0 before the first, and the questions that wait for the reviewer; `null` with neither. */
export function progressOf(round: number, waiting: number): string | null {
  const parts = [
    round === 0 ? null : `round ${round}`,
    waiting === 0 ? null : `${waiting} ${waiting === 1 ? "question" : "questions"} waiting`,
  ].filter((part) => part !== null);

  return parts.length === 0 ? null : parts.join(" · ");
}

/** The panel's live line, by where the grill stands and the last round asked: empty while a round waits for the reviewer, since the round says it. */
export function phaseText(phase: Phase, round: number): string {
  switch (phase) {
    case "working":
      return round === 0
        ? "Claude is preparing the first round."
        : `Claude is preparing round ${round + 1}.`;
    case "asking":
      return "";
    case "idle":
      return "Claude has no question open.";
    case "stopped":
      return "Claude's turn was interrupted. Add a note to continue.";
  }
}

/** The notice End grill leaves: how many questions the grill settled, and where Claude went. */
export function endedOf(decisions: number): string {
  return `Grill ended: ${decisions} ${decisions === 1 ? "decision" : "decisions"}. Claude is back on the plan.`;
}

/** What a Decline that failed says: a 409 is a proposal no longer pending, answered from another tab or replaced by Claude's next. */
export function declineFailure(status: number | null): string {
  if (status === null) {
    return "The decline did not reach the server: the proposal waits on the Grill button.";
  }

  return status === 409
    ? "Claude's proposal was already answered or replaced."
    : `The decline was refused: the server answered ${status}.`;
}

/** What an answered question reads beside it: the reviewer's words, or the recommendation and whether they chose it; `null` while it is open. */
export function answerOf(answer: Answer): { readonly label: string; readonly text: string } | null {
  switch (answer.kind) {
    case "open":
      return null;
    case "default":
      return { label: "By default", text: AS_RECOMMENDED };
    case "recommended":
      return { label: "Your answer", text: AS_RECOMMENDED };
    case "typed":
      return { label: "Your answer", text: answer.text };
  }
}

/** A chip's state in words, in its `title`: its colour alone says nothing to a screen reader. */
export function chipTitle(state: ChipState): string {
  switch (state) {
    case "answered":
      return "Answered";
    case "default":
      return "Taken as recommended, by default";
    case "waiting":
      return "Waiting: a send takes it as recommended";
  }
}
