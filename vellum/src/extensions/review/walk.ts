import type { WalkOf } from "../../core/extension.ts";
import type { Region } from "../../core/server/domain/workflow.ts";
import { parseJson, parseReviews } from "./parse.ts";
import { NO_RUNS } from "./workflow.ts";
import { regionOf } from "./workflow.ts";

function runsOf(region: Region): NonNullable<ReturnType<typeof parseReviews>> {
  return parseReviews(parseJson(String(region.data.reviews ?? ""))) ?? NO_RUNS;
}

/** What the proof of the table reads of the runs' region (`extensions/proof.ts`); the runtime never loads it. */
export const WALK: WalkOf = {
  empty: regionOf(null),
  /** The run by its kind and version, whether one failed, the agents to stop; the numbering left out. */
  key: (region) => {
    const { run, failed, stopping } = runsOf(region);

    return JSON.stringify([run?.kind, run?.version, failed !== null, stopping.length]);
  },
  /** Two agents to stop. */
  bounded: (region) => runsOf(region).stopping.length <= 2,
};
