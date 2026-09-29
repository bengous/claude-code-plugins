import type { WalkOf } from "../../runtime/extension.ts";
import type { Region } from "../../workshop/workflow.ts";
import { GRILL, regionOf, roundCall } from "./grill.ts";
import { grillFile } from "./parse.ts";
import { nextQuestion, phaseOf, unanswered } from "./transcript.ts";

function docOf(region: Region): string {
  return String(region.data.doc ?? "");
}

/** What the proof of the table reads of the grill's region (`proof.ts`); the runtime never loads it. */
export const WALK: WalkOf = {
  part: GRILL,
  empty: regionOf(null),
  /** The transcript by its phase and the questions waiting; its number left out. */
  key: (region) => JSON.stringify([phaseOf(docOf(region)), unanswered(docOf(region)).length]),
  /** Two questions a grill. */
  bounded: (region) => nextQuestion(docOf(region)) <= 3,
  call: (region) => roundCall(grillFile(Number(region.data.n)), docOf(region)),
  /** The bar's Send with the grill's part closes the round. */
  answers: (event, input) => event === "send" && input.parts === "true",
};
