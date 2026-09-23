import { AS_RECOMMENDED } from "./protocol.ts";
import type { Answer, CloseReason } from "./protocol.ts";

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

/** What the band says of the questions that wait for the reviewer; `null` when none does. */
export function waitingOf(count: number): string | null {
  if (count === 0) return null;

  return count === 1 ? "1 question waiting" : `${count} questions waiting`;
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
