import type { PlanWorkspace } from "../../core/protocol.ts";
import type { Failed, Run } from "./protocol.ts";
import { REVIEWER } from "./protocol.ts";

/** The Review button as the plan's stage and the run under way draw it, its reason in its `title`. */
export type ReviewButton =
  | { readonly kind: "ready"; readonly version: number; readonly title: string }
  | { readonly kind: "greyed"; readonly title: string }
  | { readonly kind: "running"; readonly title: string; readonly seq: number };

/**
 * `null` once approved: the bar draws no button there. A run comes before a hold, since while it
 * runs the hold is its own and its ✕ stays; another's hold greys the button with its reason.
 */
export function reviewWhy(
  workspace: PlanWorkspace,
  run: Run | null,
  held: string | null,
): ReviewButton | null {
  if (workspace.kind === "approved") return null;

  if (run !== null) {
    return {
      kind: "running",
      title: `A review of v${run.version} is running: its file lands in reviews/`,
      seq: run.seq,
    };
  }

  if (workspace.kind === "drafting") {
    return { kind: "greyed", title: "No version under review yet: submit plan.md first" };
  }

  if (held !== null) return { kind: "greyed", title: `The review is held: ${held}` };

  const { version } = workspace;

  return { kind: "ready", version, title: `Ask ${REVIEWER} to review v${version}` };
}

/** What the notice says of a run that ended without a verdict. */
export function failedText(failed: Failed): string {
  return `${REVIEWER} ended on v${failed.version} without a verdict (${failed.why}). Nothing was written.`;
}
