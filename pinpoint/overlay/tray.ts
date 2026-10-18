import type { Box, Outcome, Selection, Target, ZoneImage } from "../shared/wire.ts";
import { type Scroll, viewportBox } from "./pick.ts";

/**
 * The batch the user builds and what became of the ones sent: a pure model, which the view draws
 * and the controller changes through the functions below.
 */

/** A zone's image on its way: the selection is in the batch, its image not in yet. */
export type Waiting = { readonly waiting: true };

export const WAITING: Waiting = { waiting: true };

type ZoneTarget = Extract<Target, { readonly kind: "zone" }>;

/** A target as the batch holds it: a zone's image may still be on its way. */
export type HeldTarget =
  | Extract<Target, { readonly kind: "element" }>
  | (Omit<ZoneTarget, "image"> & { readonly image: ZoneImage | Waiting });

/** A selection as the batch holds it; `ready` makes it one the server takes. */
export type Held = Omit<Selection, "targets"> & { readonly targets: readonly HeldTarget[] };

export type Item = { readonly id: string; readonly selection: Held };

/** What a zone says of its image when the page went before it was in: its capture lives in the page. */
export const LEFT = "the page was left before the image was in";

/** A target the server takes: an element, or a zone whose image is in or said failed. */
function isIn(target: HeldTarget): target is Target {
  return target.kind === "element" || !("waiting" in target.image);
}

function heldTarget(target: HeldTarget, image: ZoneImage): HeldTarget {
  return isIn(target) ? target : { ...target, image };
}

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
    items: kept.items.map((item) => withImages(item, { failed: LEFT })),
    sent: kept.sent,
    status:
      last === undefined ? EMPTY.status : { kind: "sent", seq: last.seq, count: last.items.length },
  };
}

export function add(tray: Tray, item: Item): Tray {
  return { ...tray, items: [...tray.items, item] };
}

/** `item` with every image still on its way set to `image`; `item` itself when none was. */
function withImages(item: Item, image: ZoneImage): Item {
  const targets = item.selection.targets.map((target) => heldTarget(target, image));

  return targets.every((target, at) => target === item.selection.targets[at])
    ? item
    : { ...item, selection: { ...item.selection, targets } };
}

/** Whether the image of target `index` of item `id` is still on its way. */
export function awaits(tray: Tray, id: string, index: number): boolean {
  const target = tray.items.find((item) => item.id === id)?.selection.targets[index];

  return target !== undefined && !isIn(target);
}

/** The image of target `index` of item `id` came in; the tray as it was when it was not awaited. */
export function imaged(tray: Tray, id: string, index: number, image: ZoneImage): Tray {
  if (!awaits(tray, id, index)) return tray;

  return {
    ...tray,
    items: tray.items.map((item) =>
      item.id === id
        ? {
            ...item,
            selection: {
              ...item.selection,
              targets: item.selection.targets.map((target, at) =>
                at === index ? heldTarget(target, image) : target,
              ),
            },
          }
        : item,
    ),
  };
}

/** The images of `ids` still on their way are given up, each saying `reason`; the tray itself when none was. */
export function givenUp(tray: Tray, ids: readonly string[], reason: string): Tray {
  const items = tray.items.map((item) =>
    ids.includes(item.id) ? withImages(item, { failed: reason }) : item,
  );

  return items.every((item, at) => item === tray.items[at]) ? tray : { ...tray, items };
}

/** The selection as the server takes it; one with an image still on its way is not sent. */
export function ready(held: Held): Selection {
  const targets = held.targets.filter(isIn);

  if (targets.length !== held.targets.length) {
    throw new Error("pinpoint: a selection was sent before its image was in");
  }

  return { ...held, targets };
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
export function previewOf(selection: Held, scroll: Scroll): Box[] {
  return selection.targets.map((target) =>
    viewportBox(target.kind === "element" ? target.element.box : target.box, scroll),
  );
}

/** The last step of a selector, which names the element on screen. */
function lastStep(selector: string): string {
  return selector.split(" > ").at(-1) ?? selector;
}

/** A target as a card or the composer names it; the composer's zones have no image yet. */
type Named = HeldTarget | Omit<ZoneTarget, "image">;

function targetText(target: Named): string {
  if (target.kind === "element") return lastStep(target.element.selector);
  const { width, height } = target.box;
  const image = "image" in target && !isIn(target) ? ", image on its way" : "";

  return `zone ${Math.round(width)} × ${Math.round(height)} (${plural(target.elements.length, "element")}${image})`;
}

/** What a card and the composer call a selection: its targets, each by its short name. */
export function summaryOf(targets: readonly Named[]): string {
  return targets.map((target) => targetText(target)).join(", ");
}
