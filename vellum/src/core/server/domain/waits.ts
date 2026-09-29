import type { Outcome, Region, Wait, Workflow } from "./workflow.ts";
import { regionIn, unchanged, withRegion } from "./workflow.ts";

/**
 * One thing that waits for the reviewer under an id, as a slice keeps it: its region holds that id
 * under `data.pending`, and whether Claude's call still waits on it (`wait`), which is the
 * server's memory. On disk it keeps the one waiting, the last answered under the entry that told
 * it, and the last dropped unanswered and why, for the calls that wait on them.
 */

export type Kept<Why extends string> = {
  readonly pending: { readonly id: string } | null;
  readonly answered: { readonly id: string; readonly seq: number; readonly text: string } | null;
  readonly dropped: { readonly id: string; readonly why: Why } | null;
};

/** Where the wait on an id stands: answered, dropped and why, unknown to the server, or still open. */
export type WaitedOn<Why extends string> =
  | { readonly kind: "answered"; readonly seq: number; readonly text: string }
  | { readonly kind: "ended"; readonly why: Why }
  | { readonly kind: "gone" }
  | { readonly kind: "open" };

/** Where the wait on `id` stands, as `kept` says it: an id it does not know is gone, as after a restart. */
export function waitedOn<Why extends string>(kept: Kept<Why> | null, id: string): WaitedOn<Why> {
  if (kept?.pending?.id === id) return { kind: "open" };

  if (kept?.answered?.id === id) {
    return { kind: "answered", seq: kept.answered.seq, text: kept.answered.text };
  }

  return kept?.dropped?.id === id ? { kind: "ended", why: kept.dropped.why } : { kind: "gone" };
}

/**
 * The wait of `id`, waiting in a region read again from its file: the server's memory while the
 * same one waits (`before`, the region its last step left); paused otherwise, as after a start,
 * since no call survives a server that did not say so.
 */
export function waitAfter(before: Region | null, id: string): Wait | null {
  return before?.state === "open" && before.data.pending === id ? before.wait : "paused";
}

/**
 * The transition that marks the call's wait on `id`: `open` when its wait is posted again, `paused`
 * when its turn was cut. Any other id changes nothing.
 */
export function waitOn(w: Workflow, region: string, id: string, wait: Wait): Outcome {
  const waiting = regionIn(w, region);

  if (waiting.state !== "open" || waiting.data.pending !== id) return unchanged(w);

  return { workflow: withRegion(w, { ...waiting, wait }), effects: [] };
}
