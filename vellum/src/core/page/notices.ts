import type { PlanWorkspace } from "../protocol.ts";
import type { Version } from "../server/domain/paths.ts";
import type { BannerKind } from "./kit.tsx";

/**
 * What the page says of its state, derived: the notices under the bar, the pill, and whether
 * each decision is live and why not. Pure, so `notices.spec.ts` reads every case as a call.
 */

/** A piece of a notice's text: a literal (a path, a command) comes wrapped, and is drawn in `<code>`. */
export type NoticePart = string | { readonly code: string };

export type Notice = {
  /** One notice per cause: a cause that repeats replaces, never stacks. */
  readonly key: string;
  readonly kind: BannerKind;
  readonly text: readonly NoticePart[];
  readonly action?: { readonly label: string; readonly run: () => void };
};

/**
 * A request that failed, one per operation: a success of the same operation removes it.
 * `extension` is what an extension loads, `send` what the reviewer sends it: a load that
 * succeeds must not clear a refused send.
 */
export type Failure = {
  readonly op: "review" | "draft" | "decision" | "load" | "extension" | "send" | "edit";
  readonly text: string;
};

/** A server revived on another port never answers this tab again: past this, only a new link does. */
export const NEW_LINK_HINT_MS = 30_000;

/** Why an open editor cannot hand its text over; `null` while the version it opened on is under review. */
export function staleEditor(
  editing: { readonly version: Version } | null,
  workspace: PlanWorkspace | null,
): string | null {
  if (editing === null || workspace === null || workspace.kind === "drafting") return null;
  const live = workspace.version;

  if (workspace.kind === "inReview" && live === editing.version) return null;

  return live === editing.version
    ? `v${live} is no longer under review. Copy what you need, then Cancel.`
    : `v${live} arrived while you were editing v${editing.version}. Copy what you need, then Cancel.`;
}

/** What a Send leaves on the page until the next version: it went, and the page takes comments still. */
function sentNotice(batches: number): Notice | null {
  return batches === 0
    ? null
    : {
        key: "workspace",
        kind: "sent",
        text: ["Sent to Claude: it revises ", { code: "plan.md" }, " and goes on."],
      };
}

/** `retry` is `null` while the editor is open: an approval then would drop the typing unasked. */
function workspaceNotice(workspace: PlanWorkspace, retry: (() => void) | null): Notice | null {
  switch (workspace.kind) {
    case "drafting":
      return sentNotice(workspace.batches);
    case "inReview": {
      if (workspace.finalizeError === null) return sentNotice(workspace.batches);

      const notice: Notice = {
        key: "finalize",
        kind: "err",
        text: [
          `Could not rename the folder: ${workspace.finalizeError}. Nothing was sent to Claude.`,
        ],
      };

      if (retry === null) return notice;

      return { ...notice, action: { label: "Retry approval", run: retry } };
    }

    case "approved":
      return {
        key: "workspace",
        kind: "ok",
        text: ["Plan approved: the folder is now ", { code: workspace.dir }],
      };
  }
}

/** The core's notices, in the order the column draws them. A hold is the pill's to say, and its holder's. */
export function noticesOf(input: {
  readonly workspace: PlanWorkspace | null;
  readonly connection: "up" | "down";
  /** How long the connection has been down, in ms; `null` while it is up. */
  readonly downSince: number | null;
  readonly editing: { readonly version: Version } | null;
  readonly failures: readonly Failure[];
  /** What holds the review while a Send left the edit in the draft; `null` otherwise. */
  readonly editWaits: string | null;
  readonly undo: { readonly label: string; readonly run: () => void } | null;
  /** What "Retry approval" runs, after a rename that failed. */
  readonly retry: () => void;
}): readonly Notice[] {
  const notices: Notice[] = [];
  const down = input.connection === "down";

  if (down) {
    const late = (input.downSince ?? 0) >= NEW_LINK_HINT_MS;

    notices.push({
      key: "connection",
      kind: "err",
      text: [
        "Connection to the review server lost. Retrying… Your comments are kept in this tab, not saved.",
        ...(late ? [" Run ", { code: "/vellum:start" }, " for a new link."] : []),
      ],
    });
  }

  for (const failure of input.failures) {
    if (down && failure.op === "draft") continue;
    notices.push({ key: `failure:${failure.op}`, kind: "err", text: [failure.text] });
  }

  if (input.editWaits !== null) {
    notices.push({
      key: "edit-waits",
      kind: "info",
      text: [`Your edit waits: ${input.editWaits}. Send it again once that ends.`],
    });
  }

  const stale = staleEditor(input.editing, input.workspace);

  if (stale !== null) notices.push({ key: "stale-editor", kind: "err", text: [stale] });

  const own =
    input.workspace === null
      ? null
      : workspaceNotice(input.workspace, input.editing === null ? input.retry : null);

  if (own !== null) notices.push(own);

  if (input.undo !== null) {
    notices.push({ key: "undo", kind: "info", text: ["Comment deleted."], action: input.undo });
  }

  return notices;
}

export type Status = { readonly text: string; readonly tone: "ok" | "err" | "neutral" };

/** The pill: what state the review is in, `Held · <reason>` when something holds it. */
export function statusOf(workspace: PlanWorkspace, held: string | null): Status {
  switch (workspace.kind) {
    case "drafting":
      return {
        text: workspace.batches === 0 ? "Drafting" : `Drafting · ${workspace.batches} sent`,
        tone: "neutral",
      };
    case "inReview":
      if (workspace.finalizeError !== null) return { text: "Approval failed", tone: "err" };

      if (held !== null) return { text: `Held · ${held}`, tone: "neutral" };

      return {
        text: workspace.batches === 0 ? "In review" : `In review · ${workspace.batches} sent`,
        tone: "neutral",
      };
    case "approved":
      return { text: "Approved", tone: "ok" };
  }
}

export type Live = { readonly disabled: boolean; readonly title: string | null };

export type Decisions = { readonly approve: Live; readonly notes: Live; readonly send: Live };

const LIVE: Live = { disabled: false, title: null };

function greyed(title: string): Live {
  return { disabled: true, title };
}

/**
 * The three buttons of the core: greyed or not, and why, the reason written in its `title`. An
 * extension's button is computed by the extension. A Send is never held: a hold refuses Claude's
 * versions, and the reviewer's word goes.
 */
export function decisionsOf(input: {
  readonly workspace: PlanWorkspace | null;
  readonly connection: "up" | "down";
  readonly editing: boolean;
  readonly sending: boolean;
  /** What `Send (n)` counts: the comments, the choices a Send takes, the questions answered, 1 for an edit. */
  readonly count: number;
  /** Questions a Send would take by default: something to send, which the page asks about first. */
  readonly unanswered: number;
  /** Something to send `count` does not count: a note for Claude. */
  readonly more: boolean;
  /** Texts typed and not added, which a Send would throw. */
  readonly strayTyped: number;
}): Decisions {
  const { workspace } = input;

  const common =
    workspace === null
      ? "Loading the review"
      : input.connection === "down"
        ? "The connection to the review server is lost"
        : input.editing
          ? "Finish editing (Done) first"
          : workspace.kind === "approved"
            ? "The plan is approved"
            : null;

  if (common !== null || workspace === null) {
    const all = greyed(common ?? "Loading the review");

    return { approve: all, notes: all, send: all };
  }

  const approve =
    workspace.kind === "drafting"
      ? greyed("No version to approve yet")
      : workspace.kind === "inReview" && workspace.finalizeError !== null
        ? greyed("Retry the approval from the banner")
        : LIVE;

  const nothing =
    input.strayTyped > 0
      ? "Add the comment you typed first (Add comment)"
      : "Add a comment, answer a question or edit the plan first";

  const something = input.count > 0 || input.unanswered > 0 || input.more;
  const send = input.sending ? greyed("Sending") : something ? LIVE : greyed(nothing);

  return { approve, notes: approve, send };
}
