import type { TurnCompleteInput } from "claude-code";

/** A main-loop turn that ended on the model's answer. */
export const TURN_ANSWERED: TurnCompleteInput = {
  answer: "done",
  durationMs: 1,
  isAborted: false,
  turnId: "t1",
  reason: "answer",
};

/** The same turn, interrupted. */
export const TURN_ABORTED: TurnCompleteInput = {
  ...TURN_ANSWERED,
  reason: "aborted",
  isAborted: true,
};

/** The same turn, a subagent's. */
export const TURN_OF_AGENT: TurnCompleteInput = { ...TURN_ANSWERED, agentId: "a1" };
