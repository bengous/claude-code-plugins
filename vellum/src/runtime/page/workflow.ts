import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { createStore } from "zustand/vanilla";

import type { Decision, Edit } from "../../review/contract.ts";
import type { PlanWorkspace } from "../protocol.ts";
import { postRecord } from "./api.ts";
import type { Failure, Notice } from "./notices.ts";
import { noticesOf } from "./notices.ts";
import type { EditSession, Outgoing, Page, PageModule, Sent } from "./state.ts";
import { memoized, pageModule, patchStore, selectHeld, selectWorkflow } from "./state.ts";

/**
 * The page as a reader of the workflow the server sends, `ReviewView.workflow`: the approval and
 * Record, the edit a hold keeps in the draft, and the column of notices. What holds the review
 * and the pill are `selectHeld` and `selectWorkflow` of `state.ts`, which this module reads too.
 */

/**
 * What an approval came to: taken; refused or failed, which the notices say; or asked to confirm a
 * hold other than the one the decision confirmed, which the bar asks about again.
 */
export type Approval =
  | { readonly kind: "taken" }
  | { readonly kind: "held"; readonly reason: string }
  | { readonly kind: "refused" };

/** What this reader keeps of its own: the edit a Send left in the draft, and what held the review. */
export type Flow = {
  /**
   * The edit a Send left in the draft, and what held the review, in the server's words: the
   * notice says so while that very edit waits, until a load reads that nothing holds the review.
   */
  readonly editWaits: { readonly held: string; readonly edit: Edit } | null;
};

export type WorkflowModule = {
  readonly flowStore: StoreApi<Flow>;
  /** The core's notices, drawn under the bar in this order, read off both states. */
  readonly selectNotices: (page: Page, flow: Flow) => readonly Notice[];
  /** The same, for a component: one read per input, so a hover or a Ctrl redraws nothing here. */
  readonly useNotices: () => readonly Notice[];
  readonly send: (out: Outgoing) => Promise<Sent>;
  readonly approve: (decision: Decision) => Promise<Approval>;
};

/** The approval's rows the page answers in its own way: the hold's confirmation, and `plan.md` changed since the version. */
const HELD = "held";

const DRAFT = "approve-draft";

const RETRY: Decision = { kind: "approve", edit: null, notes: "" };

/** What the notices read, in `noticesOf`'s order, `editWaits` last. */
type NoticeInputs = [
  PlanWorkspace | null,
  "up" | "down",
  number | null,
  EditSession | null,
  readonly Failure[],
  Edit | null,
  Page["undo"],
  Flow["editWaits"],
];

/**
 * The workflow's store and actions over `module`. The page runs one, over its own store; a suite
 * builds one over each store it builds fresh, which this module's own would never see.
 */
export function workflowOf(module: PageModule): WorkflowModule {
  const { store } = module;
  const flowStore = createStore<Flow>(() => ({ editWaits: null }));

  /** A load that reads that nothing holds the review ends the wait. */
  const freeOn = (s: Page): void => {
    if (selectWorkflow(s)?.held === null) patchStore(flowStore, { editWaits: null });
  };

  freeOn(store.getState());

  store.subscribe((s, prev) => {
    if (s.review !== prev.review) freeOn(s);
  });

  /** A Send with an edit: what the server did with it is the notice; one with none, Send now, leaves the notice as it is. */
  async function send(out: Outgoing): Promise<Sent> {
    const sent = await module.send(out);
    const { edit } = out;

    if (edit === null) return sent;

    if (sent.kind === "kept") patchStore(flowStore, { editWaits: { held: sent.reason, edit } });
    else if (sent.kind === "sent") {
      patchStore(flowStore, {
        editWaits: sent.editKept === null ? null : { held: sent.editKept, edit },
      });
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
        module.fail(
          "decision",
          "Record did not reach the server. Your comments are kept in this tab.",
        );

        return;
      }

      const { status, answer } = recorded;

      if (status >= 300) {
        const reason = answer !== null && "reason" in answer ? answer.reason : null;

        module.fail(
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
    const decided = await module.decide(decision);

    if (decided.kind === "taken") return decided;

    if (decided.kind === "failed") return { kind: "refused" };
    const { rule, reason } = decided;

    if (rule === HELD && reason !== null) return { kind: "held", reason };

    const offered =
      rule === DRAFT && decision.edit === null && selectHeld(store.getState()) === null;

    const record = { label: "Record, then approve", run: () => void recordThenApprove(decision) };

    module.fail(
      "decision",
      reason ?? "This version was already decided.",
      offered ? record : undefined,
    );

    return { kind: "refused" };
  }

  /** An approval from outside the bar, which cannot ask about the hold again: the confirmation asked is said as a refusal. */
  async function approveOrSay(decision: Decision): Promise<void> {
    const approval = await approve(decision);

    if (approval.kind === "held") module.fail("decision", approval.reason);
  }

  const retry = (): void => void approveOrSay(RETRY);

  const noticesFrom = memoized(
    (...inputs: NoticeInputs) => inputs,
    (workspace, connection, downSince, editing, failures, edited, undo, editWaits) =>
      noticesOf({
        workspace,
        connection,
        downSince,
        editing,
        failures,
        editWaits: editWaits !== null && editWaits.edit === edited ? editWaits.held : null,
        undo,
        retry,
      }),
  );

  function selectNotices(page: Page, flow: Flow): readonly Notice[] {
    return noticesFrom(
      page.review?.workspace ?? null,
      page.connection,
      page.downFor,
      page.editing,
      page.failures,
      page.edited,
      page.undo,
      flow.editWaits,
    );
  }

  function useNotices(): readonly Notice[] {
    const workspace = useStore(store, (s) => s.review?.workspace ?? null);
    const connection = useStore(store, (s) => s.connection);
    const downFor = useStore(store, (s) => s.downFor);
    const editing = useStore(store, (s) => s.editing);
    const failures = useStore(store, (s) => s.failures);
    const edited = useStore(store, (s) => s.edited);
    const undo = useStore(store, (s) => s.undo);
    const editWaits = useStore(flowStore, (s) => s.editWaits);

    return noticesFrom(workspace, connection, downFor, editing, failures, edited, undo, editWaits);
  }

  return { flowStore, selectNotices, useNotices, send, approve };
}

export const { flowStore, selectNotices, useNotices, send, approve } = workflowOf(pageModule);
