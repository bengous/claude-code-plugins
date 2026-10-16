import type { Selection, Target } from "../shared/wire.ts";

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
  | { readonly kind: "failed"; readonly reason: string };

/** A batch the server took: kept until the session took it, so a batch dropped comes back. */
type Sent = { readonly seq: number; readonly items: readonly Item[] };

export type Tray = {
  readonly items: readonly Item[];
  readonly sent: readonly Sent[];
  readonly status: Status;
};

export const EMPTY: Tray = { items: [], sent: [], status: { kind: "idle" } };

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

export function delivered(tray: Tray, seq: number): Tray {
  const batch = tray.sent.find((one) => one.seq === seq);
  const count = batch?.items.length ?? 0;
  const latest = tray.status.kind === "sent" && tray.status.seq === seq;

  return {
    ...tray,
    sent: tray.sent.filter((one) => one.seq !== seq),
    status: latest ? { kind: "delivered", seq, count } : tray.status,
  };
}

/** The session did not take batch `seq`: its items come back to the head of the batch. */
export function dropped(tray: Tray, seq: number, reason: string): Tray {
  const back = tray.sent.find((one) => one.seq === seq)?.items ?? [];

  return {
    items: [...back, ...tray.items],
    sent: tray.sent.filter((one) => one.seq !== seq),
    status: { kind: "dropped", seq, reason },
  };
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
    case "failed":
      return `Not sent: ${status.reason}. The selections stay here.`;
  }
}

/** The last step of a selector, which names the element on screen. */
function lastStep(selector: string): string {
  return selector.split(" > ").at(-1) ?? selector;
}

function targetText(target: Target): string {
  if (target.kind === "element") return lastStep(target.element.selector);
  const { width, height } = target.box;

  return `zone ${Math.round(width)} × ${Math.round(height)} (${plural(target.elements.length, "element")})`;
}

/** What a card and the composer call a selection: its targets, each by its short name. */
export function summaryOf(targets: readonly Target[]): string {
  return targets.map((target) => targetText(target)).join(", ");
}
