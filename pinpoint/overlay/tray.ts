import type { Box, Outcome, Selection, Target } from "../shared/wire.ts";
import { type Scroll, viewportBox } from "./pick.ts";

/**
 * The batch the user builds and what became of the ones sent: a pure model, which the view draws
 * and the controller changes through the functions below.
 */

export type Item = { readonly id: string; readonly selection: Selection };

/** Where the last send stands, as the panel's one status line says it. */
export type Status =
  | { readonly kind: "idle" }
  | { readonly kind: "sending"; readonly count: number }
  | { readonly kind: "sent"; readonly seq: number; readonly count: number }
  | { readonly kind: "delivered"; readonly seq: number; readonly count: number }
  | { readonly kind: "dropped"; readonly seq: number; readonly reason: string }
  | { readonly kind: "unknown"; readonly seq: number }
  | { readonly kind: "failed"; readonly reason: string };

/** A batch the server took: kept until the session took it, so a batch dropped comes back. */
type Sent = { readonly seq: number; readonly items: readonly Item[] };

export type Tray = {
  readonly items: readonly Item[];
  readonly sent: readonly Sent[];
  readonly status: Status;
};

export const EMPTY: Tray = { items: [], sent: [], status: { kind: "idle" } };

/** The tray a reloaded page kept: its status says the last batch still waiting, if one is. */
export function restored(kept: Pick<Tray, "items" | "sent">): Tray {
  const last = kept.sent.at(-1);

  return {
    items: kept.items,
    sent: kept.sent,
    status:
      last === undefined ? EMPTY.status : { kind: "sent", seq: last.seq, count: last.items.length },
  };
}

export function add(tray: Tray, item: Item): Tray {
  return { ...tray, items: [...tray.items, item] };
}

export function remove(tray: Tray, id: string): Tray {
  return { ...tray, items: tray.items.filter((item) => item.id !== id) };
}

export function sending(tray: Tray, count: number): Tray {
  return { ...tray, status: { kind: "sending", count } };
}

/** The server took the items `ids` as batch `seq`: they leave the batch. */
export function accepted(tray: Tray, ids: readonly string[], seq: number): Tray {
  const taken = tray.items.filter((item) => ids.includes(item.id));

  return {
    items: tray.items.filter((item) => !ids.includes(item.id)),
    sent: [...tray.sent, { seq, items: taken }],
    status: { kind: "sent", seq, count: taken.length },
  };
}

/** The send failed before the server took it: the items stay where they are. */
export function failed(tray: Tray, reason: string): Tray {
  return { ...tray, status: { kind: "failed", reason } };
}

/**
 * What the server says became of a batch: delivered, said if it is the last one sent; dropped,
 * its items back at the head of the batch; unknown, said once. A batch this tab did not send, or
 * one still pending, changes nothing.
 */
export function settle(tray: Tray, outcome: Outcome): Tray {
  const { seq } = outcome;
  const batch = tray.sent.find((one) => one.seq === seq);

  if (batch === undefined || outcome.outcome === "pending") return tray;
  const sent = tray.sent.filter((one) => one !== batch);

  switch (outcome.outcome) {
    case "delivered": {
      const latest = tray.status.kind === "sent" && tray.status.seq === seq;
      const count = batch.items.length;

      return { ...tray, sent, status: latest ? { kind: "delivered", seq, count } : tray.status };
    }

    case "dropped":
      return {
        items: [...batch.items, ...tray.items],
        sent,
        status: { kind: "dropped", seq, reason: outcome.reason },
      };
    case "unknown":
      return { ...tray, sent, status: { kind: "unknown", seq } };
  }
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function statusText(status: Status): string {
  switch (status.kind) {
    case "idle":
      return "";
    case "sending":
      return `Sending ${plural(status.count, "selection")}…`;
    case "sent":
      return `Batch ${status.seq} sent, waiting for the session.`;
    case "delivered":
      return `Batch ${status.seq} delivered to the session (${plural(status.count, "selection")}).`;
    case "dropped":
      return `Batch ${status.seq} was not delivered: ${status.reason}. Its selections are back in the batch.`;
    case "unknown":
      return `Batch ${status.seq}: the server no longer knows what became of it.`;
    case "failed":
      return `Not sent: ${status.reason}. The selections stay here.`;
  }
}

/** The panel's send button: Ctrl+Enter sends only while pointing, and is the app's otherwise. */
export function sendText(count: number, pointing: boolean): string {
  return `Send (${count})${pointing ? " · Ctrl+Enter" : ""}`;
}

/** Where the viewport draws a selection's targets, the page scrolled by `scroll`: each element's box, each zone's own. */
export function previewOf(selection: Selection, scroll: Scroll): Box[] {
  return selection.targets.map((target) =>
    viewportBox(target.kind === "element" ? target.element.box : target.box, scroll),
  );
}

/** The last step of a selector, which names the element on screen. */
function lastStep(selector: string): string {
  return selector.split(" > ").at(-1) ?? selector;
}

/** A target as the composer names it, a zone's image not in yet. */
type Named = Target | Omit<Extract<Target, { readonly kind: "zone" }>, "image">;

function targetText(target: Named): string {
  if (target.kind === "element") return lastStep(target.element.selector);
  const { width, height } = target.box;

  return `zone ${Math.round(width)} × ${Math.round(height)} (${plural(target.elements.length, "element")})`;
}

/** What a card and the composer call a selection: its targets, each by its short name. */
export function summaryOf(targets: readonly Named[]): string {
  return targets.map((target) => targetText(target)).join(", ");
}
