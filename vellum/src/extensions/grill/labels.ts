import type { CloseReason } from "./protocol.ts";

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

/** What a Decline that failed says: a 409 is a proposal no longer pending, answered from another tab or replaced by Claude's next. */
export function declineFailure(status: number | null): string {
  if (status === null) {
    return "The decline did not reach the server: the proposal waits on the Grill button.";
  }

  return status === 409
    ? "Claude's proposal was already answered or replaced."
    : `The decline was refused: the server answered ${status}.`;
}
