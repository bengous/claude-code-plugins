import type { ReadonlySignal } from "@preact/signals";
import { computed, effect, signal } from "@preact/signals";

import type { Decision, Edit } from "../../review/contract.ts";
import type { WorkflowView } from "../protocol.ts";
import { postRecord } from "./api.ts";
import type { Notice } from "./notices.ts";
import { noticesOf } from "./notices.ts";
import type { Outgoing, Sent } from "./state.ts";
import * as page from "./state.ts";

/**
 * The page as a reader of the workflow the server sends, `ReviewView.workflow`: what holds the
 * review, the pill and what is refused now, the approval and Record, and the edit a hold keeps in
 * the draft. `state.ts` reads none of it.
 */

/**
 * What an approval came to: taken; refused or failed, which the notices say; or asked to confirm a
 * hold other than the one the decision confirmed, which the bar asks about again.
 */
export type Approval =
  | { readonly kind: "taken" }
  | { readonly kind: "held"; readonly reason: string }
  | { readonly kind: "refused" };

export type WorkflowStore = {
  readonly workflow: ReadonlySignal<WorkflowView | null>;
  /** What holds the review, in the holder's words; `null` when nothing does. */
  readonly held: ReadonlySignal<string | null>;
  readonly send: (out: Outgoing) => Promise<Sent>;
  readonly approve: (decision: Decision) => Promise<Approval>;
  /** The core's notices, drawn under the bar in this order. */
  readonly notices: ReadonlySignal<readonly Notice[]>;
};

/** The approval's rows the page answers in its own way: the hold's confirmation, and `plan.md` changed since the version. */
const HELD = "held";

const DRAFT = "approve-draft";

const RETRY: Decision = { kind: "approve", edit: null, notes: "" };

/**
 * The workflow's signals and actions over `store`. The page runs one, over its own store; a suite
 * builds one over each store it imports fresh, which this module's own would never see.
 */
export function workflowOf(store: typeof page): WorkflowStore {
  const workflow = computed<WorkflowView | null>(() => store.review.value?.workflow ?? null);
  const held = computed(() => workflow.value?.held ?? null);

  /**
   * The edit a Send left in the draft, and what held the review, in the server's words: the
   * notice says so while that very edit waits, until a load reads that nothing holds the review.
   */
  const editWaits = signal<{ readonly held: string; readonly edit: Edit } | null>(null);

  effect(() => {
    if (workflow.value?.held === null) editWaits.value = null;
  });

  /** A Send with an edit: what the server did with it is the notice; one with none, Send now, leaves the notice as it is. */
  async function send(out: Outgoing): Promise<Sent> {
    const sent = await store.send(out);
    const { edit } = out;

    if (edit === null) return sent;

    if (sent.kind === "kept") editWaits.value = { held: sent.reason, edit };
    else if (sent.kind === "sent") {
      editWaits.value = sent.editKept === null ? null : { held: sent.editKept, edit };
    }

    return sent;
  }

  let recording = false;

  /** `plan.md` recorded as the next version, then the decision refused taken again, once at a time. */
  async function recordThenApprove(decision: Decision): Promise<void> {
    if (recording) return;
    recording = true;

    try {
      const recorded = await postRecord().catch(() => null);

      if (recorded === null) {
        store.fail(
          "decision",
          "Record did not reach the server. Your comments are kept in this tab.",
        );

        return;
      }

      const { status, answer } = recorded;

      if (status >= 300) {
        const reason = answer !== null && "reason" in answer ? answer.reason : null;

        store.fail(
          "decision",
          reason === null
            ? `Not recorded: the server answered ${status}.`
            : `Not recorded: ${reason}.`,
        );

        return;
      }

      await approveOrSay(decision);
    } finally {
      recording = false;
    }
  }

  /**
   * The approval. A refusal is said in the words of its row. `plan.md` changed since the version
   * offers Record, then approve, unless a hold holds, whose row then says to end it first, or the
   * decision carries an edit, which the version recorded would leave stale.
   */
  async function approve(decision: Decision): Promise<Approval> {
    const decided = await store.decide(decision);

    if (decided.kind === "taken") return decided;

    if (decided.kind === "failed") return { kind: "refused" };
    const { rule, reason } = decided;

    if (rule === HELD && reason !== null) return { kind: "held", reason };
    const offered = rule === DRAFT && decision.edit === null && held.peek() === null;
    const record = { label: "Record, then approve", run: () => void recordThenApprove(decision) };

    store.fail(
      "decision",
      reason ?? "This version was already decided.",
      offered ? record : undefined,
    );

    return { kind: "refused" };
  }

  /** An approval from outside the bar, which cannot ask about the hold again: the confirmation asked is said as a refusal. */
  async function approveOrSay(decision: Decision): Promise<void> {
    const approval = await approve(decision);

    if (approval.kind === "held") store.fail("decision", approval.reason);
  }

  const notices = computed(() =>
    noticesOf({
      workspace: store.review.value?.workspace ?? null,
      connection: store.connection.value,
      downSince: store.downFor.value,
      editing: store.editing.value,
      failures: store.failures.value,
      editWaits:
        editWaits.value !== null && editWaits.value.edit === store.edited.value
          ? editWaits.value.held
          : null,
      undo: store.undo.value,
      retry: () => void approveOrSay(RETRY),
    }),
  );

  return { workflow, held, send, approve, notices };
}

export const { workflow, held, send, approve, notices } = workflowOf(page);
