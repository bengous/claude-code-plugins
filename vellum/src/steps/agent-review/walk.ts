import type { WalkOf } from "../../runtime/extension.ts";
import type { Region } from "../../workshop/workflow.ts";
import { NO_RUNS, regionOf, REVIEW } from "./agent-review.ts";
import { parseJson, parseReviews } from "./parse.ts";

function runsOf(region: Region): NonNullable<ReturnType<typeof parseReviews>> {
  return parseReviews(parseJson(String(region.data.reviews ?? ""))) ?? NO_RUNS;
}

/** What the proof of the table reads of the runs' region (`proof.ts`); the runtime never loads it. */
export const WALK: WalkOf = {
  part: REVIEW,
  empty: regionOf(null),
  /** The run by its kind and version, whether one failed, the agents to stop; the numbering left out. */
  key: (region) => {
    const { run, failed, stopping } = runsOf(region);

    return JSON.stringify([run?.kind, run?.version, failed !== null, stopping.length]);
  },
  /** Two agents to stop. */
  bounded: (region) => runsOf(region).stopping.length <= 2,
};
