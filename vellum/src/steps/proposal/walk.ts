import type { WalkOf } from "../../runtime/extension.ts";
import { planExists } from "../../workshop/workflow.ts";
import { fileOf, pendingOf, regionOf, STEP } from "./proposal.ts";

/** What the proof of the table reads of the step's region (`proof.ts`); the runtime never loads it. */
export const WALK: WalkOf = {
  part: STEP,
  empty: regionOf(null),
  /** The proposal by its id and its moves' kinds. */
  key: (region) =>
    JSON.stringify([
      region.data.pending,
      fileOf(region).pending?.proposal.moves.map(({ kind }) => kind),
    ]),
  call: (region) => String(region.data.pending),
  answers: (event) => event === "answerProposal",
  invariants: {
    noPlanStepOverAPlan: (w) =>
      planExists(w) && pendingOf(w)?.proposal.moves.some(({ kind }) => kind === "plan") === true,
  },
};
