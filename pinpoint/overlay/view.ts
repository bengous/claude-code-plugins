import type { Box } from "../shared/wire.ts";
import { folderOf, sessionTitle } from "./config.ts";
import { sendText, statusText, summaryOf, type Tray } from "./tray.ts";

/**
 * Everything the overlay draws, in one shadow root so the app's styles never reach it: the
 * layer of boxes over the page, the composer, and the panel that holds the batch.
 */

export type Handlers = {
  readonly toggle: () => void;
  readonly label: (label: string) => void;
  readonly sendAll: () => void;
  readonly sendOne: (id: string) => void;
  readonly remove: (id: string) => void;
  /** A card hovered or focused shows where its targets are; `null` when it leaves. */
  readonly preview: (id: string | null) => void;
  /** The composer dragged to `spot`, where it now opens; `null` to open it beside each pick again. */
  readonly pin: (spot: Spot | null) => void;
};

export type View = {
  readonly host: HTMLElement;
  readonly setOn: (on: boolean) => void;
  /** While Ctrl (⌘) is held, the composer and the panel fade and let a click through to the page. */
  readonly setAdding: (adding: boolean) => void;
  readonly hover: (box: Box | null, label: string) => void;
  readonly drag: (box: Box | null) => void;
  /** The boxes of the selection being written, and of a card previewed. */
  readonly marks: (draft: readonly Box[], preview: readonly Box[]) => void;
  readonly openComposer: (
    near: Box,
    summary: string,
    note: string,
    pinned: Spot | null,
  ) => HTMLTextAreaElement;
  readonly closeComposer: () => void;
  readonly composerNote: () => string;
  readonly shakeComposer: () => void;
  readonly renderTray: (tray: Tray, connected: boolean, on: boolean) => void;
};

const STYLE = `
:host { all: initial; }
* { box-sizing: border-box; }
.root {
  --bg: #ffffff; --fg: #161a21; --muted: #5a6474; --line: #d5dbe4; --pick: #2a66cc;
  --wash: rgba(42, 102, 204, 0.1); --zone: #b25e0c; --err: #b3261e; --ok: #23804a;
  font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--fg);
}
@media (prefers-color-scheme: dark) {
  .root { --bg: #171b22; --fg: #e5e9ef; --muted: #98a3b3; --line: #2c333d; --pick: #6ea3ff;
    --wash: rgba(110, 163, 255, 0.14); --zone: #f0a24a; --err: #ff8a80; --ok: #4cc27a; }
}
.layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483646; }
.box { position: fixed; border: 2px solid var(--pick); background: var(--wash); border-radius: 2px; }
.box.hover { border-style: dashed; background: transparent; }
.box.drag { border-style: dashed; border-color: var(--zone); background: transparent; }
.box.preview { border-color: var(--zone); background: transparent; }
.tag { position: fixed; padding: 2px 6px; border-radius: 3px; background: var(--pick); color: #fff;
  font: 600 11px/1.3 ui-monospace, Menlo, Consolas, monospace; white-space: nowrap; }
.composer, .panel { pointer-events: auto; background: var(--bg); border: 1px solid var(--line);
  border-radius: 8px; box-shadow: 0 6px 24px rgba(0, 0, 0, 0.18); }
.composer { position: fixed; width: 340px; padding: 10px; display: grid; gap: 8px; z-index: 2147483647; }
.adding .composer, .adding .panel { opacity: 0.3; pointer-events: none; }
.composer.shake { animation: shake 0.2s; }
@keyframes shake { 25% { transform: translateX(-4px); } 75% { transform: translateX(4px); } }
@media (prefers-reduced-motion: reduce) { .composer.shake { animation: none; outline: 2px solid var(--err); } }
.summary { font: 12px/1.3 ui-monospace, Menlo, Consolas, monospace; color: var(--muted); overflow-wrap: anywhere; }
.grip { display: flex; align-items: center; gap: 8px; cursor: grab; user-select: none; touch-action: none; }
.moving .grip { cursor: grabbing; }
.grip .summary { flex: 1; }
.dots { flex: none; width: 8px; height: 12px;
  background: radial-gradient(circle, var(--muted) 1px, transparent 1.5px) 0 0 / 4px 4px; }
.unpin { flex: none; border: 1px solid var(--line); background: transparent; padding: 1px 8px; font-size: 12px; }
.unpin:hover { border-color: var(--pick); color: var(--pick); }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
button { font: inherit; color: inherit; cursor: pointer; border-radius: 5px; }
button:focus-visible, textarea:focus-visible { outline: 2px solid var(--pick); outline-offset: 1px; }
.chip { border: 1px solid var(--line); background: transparent; padding: 3px 8px; }
.chip:hover { border-color: var(--pick); color: var(--pick); }
textarea { font: inherit; color: inherit; background: transparent; border: 1px solid var(--line);
  border-radius: 6px; padding: 6px 8px; min-height: 56px; resize: vertical; width: 100%; }
.hint { font-size: 11px; color: var(--muted); }
.panel { position: fixed; right: 16px; bottom: 16px; width: 320px; max-width: calc(100vw - 32px);
  max-height: 60vh; display: grid; grid-template-rows: auto minmax(0, 1fr) auto; z-index: 2147483647; }
.head { display: flex; flex-wrap: wrap; align-items: center; column-gap: 8px; row-gap: 2px; padding: 8px 10px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--err); flex: none; }
.dot.up { background: var(--ok); }
.name { font-weight: 600; }
.count { color: var(--muted); white-space: nowrap; }
.session { order: 1; flex: 1 0 100%; min-width: 0; padding-left: 16px; font-size: 12px; color: var(--muted);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session b { font-weight: 600; color: var(--fg); }
.toggle { margin-left: auto; border: 1px solid var(--pick); background: transparent; color: var(--pick); padding: 3px 8px; white-space: nowrap; }
.toggle.on { background: var(--pick); color: #fff; }
.list { overflow: auto; display: grid; gap: 6px; padding: 0 10px; }
.card { border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; display: grid; gap: 4px; }
.card:hover, .card:focus-within { border-color: var(--pick); }
.label { justify-self: start; font-size: 11px; font-weight: 600; color: var(--zone); }
.note { overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.actions { display: flex; gap: 6px; justify-content: flex-end; }
.actions button { border: 1px solid var(--line); background: transparent; padding: 1px 8px; font-size: 12px; }
.foot { display: grid; gap: 6px; padding: 8px 10px; }
.status { font-size: 12px; color: var(--muted); }
.status.err { color: var(--err); }
.send { border: none; background: var(--pick); color: #fff; padding: 6px 10px; font-weight: 600; }
.send:disabled { opacity: 0.5; cursor: default; }
`;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text = "",
): HTMLElementTagNameMap[K] {
  const made = document.createElement(tag);
  made.className = className;
  made.textContent = text;

  return made;
}

function place(node: HTMLElement, box: Box): void {
  node.style.left = `${box.x}px`;
  node.style.top = `${box.y}px`;
  node.style.width = `${box.width}px`;
  node.style.height = `${box.height}px`;
}

const GAP = 8;

/** The viewport's top-left corner of a box the overlay places. */
export type Spot = { readonly x: number; readonly y: number };

type Size = { readonly width: number; readonly height: number };

/** `start` moved so that `size` from it ends a gap before `limit`; the gap when it cannot fit. */
function within(start: number, size: number, limit: number): number {
  return Math.min(Math.max(GAP, start), Math.max(GAP, limit - size - GAP));
}

/**
 * Where a composer of `size` opens: beside `near`, right then left, so the elements above and
 * below stay in reach of a Ctrl+click; else below, else above. Always inside the viewport.
 */
export function composerSpot(near: Box, size: Size, viewport: Size): Spot {
  const clampX = (x: number): number => within(x, size.width, viewport.width);
  const clampY = (y: number): number => within(y, size.height, viewport.height);

  const right = near.x + near.width + GAP;
  const left = near.x - size.width - GAP;

  if (right + size.width + GAP <= viewport.width) return { x: right, y: clampY(near.y) };

  if (left >= GAP) return { x: left, y: clampY(near.y) };
  const below = near.y + near.height + GAP;

  return below + size.height <= viewport.height
    ? { x: clampX(near.x), y: below }
    : { x: clampX(near.x), y: clampY(near.y - size.height - GAP) };
}

/** Where a pinned composer of `size` opens: its pinned spot, moved so all of it stays in the viewport. */
export function pinnedSpot(pinned: Spot, size: Size, viewport: Size): Spot {
  return {
    x: within(pinned.x, size.width, viewport.width),
    y: within(pinned.y, size.height, viewport.height),
  };
}

function windowSize(): Size {
  return { width: window.innerWidth, height: window.innerHeight };
}

/** `sessionRoot` is the directory of the session the batches go to, which the panel names. */
export function createView(
  labels: readonly string[],
  sessionRoot: string,
  handlers: Handlers,
): View {
  const host = document.createElement("pinpoint-overlay");
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = STYLE;
  const root = element("div", "root");
  const layer = element("div", "layer");
  const hoverBox = element("div", "box hover");
  const hoverTag = element("div", "tag");
  const dragBox = element("div", "box drag");
  const marksLayer = element("div", "");
  layer.append(marksLayer, hoverBox, hoverTag, dragBox);

  const composer = element("div", "composer");
  const grip = element("div", "grip");
  grip.title = "Drag to move: the composer opens there until you unpin it";
  const summary = element("div", "summary");
  const unpin = element("button", "unpin", "Unpin");
  unpin.type = "button";
  unpin.title = "Open the composer beside each pick again";
  unpin.addEventListener("click", () => handlers.pin(null));
  grip.append(element("span", "dots"), summary, unpin);
  const chips = element("div", "chips");

  for (const label of labels) {
    const chip = element("button", "chip", label);
    chip.type = "button";
    chip.addEventListener("click", () => handlers.label(label));
    chips.append(chip);
  }

  const note = element("textarea", "");
  note.setAttribute("aria-label", "Note for Claude");
  note.placeholder = "What should change? Enter adds it to the batch.";

  const hint = element(
    "div",
    "hint",
    "Enter add · Shift+Enter new line · Ctrl+Enter send all · Esc cancel · Ctrl+click add an element",
  );

  composer.append(grip, ...(labels.length === 0 ? [] : [chips]), note, hint);

  const moveComposer = (spot: Spot): void => {
    composer.style.left = `${spot.x}px`;
    composer.style.top = `${spot.y}px`;
  };

  /** The composer as drawn: its height follows how many rows the labels wrap to. */
  const composerSize = (): Size => ({ width: composer.offsetWidth, height: composer.offsetHeight });

  const inView = (spot: Spot): Spot => pinnedSpot(spot, composerSize(), windowSize());

  /** Where the pointer holds the composer from its corner, and where it moved it; `null` with no drag. */
  let drag: { readonly grab: Spot; readonly at: Spot | null } | null = null;

  const endDrag = (): void => {
    if (drag === null) return;
    const { at } = drag;
    drag = null;
    composer.classList.remove("moving");

    if (at !== null) handlers.pin(at);
  };

  grip.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.composedPath().includes(unpin)) return;
    // No text selection starts, the focus stays in the note, and the app gets no mouse event.
    event.preventDefault();
    const corner = composer.getBoundingClientRect();
    drag = { grab: { x: event.clientX - corner.left, y: event.clientY - corner.top }, at: null };
    grip.setPointerCapture(event.pointerId);
    composer.classList.add("moving");
  });

  grip.addEventListener("pointermove", (event) => {
    if (drag === null) return;
    event.stopPropagation();
    const at = inView({ x: event.clientX - drag.grab.x, y: event.clientY - drag.grab.y });
    drag = { ...drag, at };
    moveComposer(at);
  });

  grip.addEventListener("pointerup", endDrag);
  grip.addEventListener("pointercancel", endDrag);

  const panel = element("div", "panel");
  const head = element("div", "head");
  const dot = element("span", "dot");
  const name = element("span", "name", "pinpoint");
  const count = element("span", "count");
  const session = element("span", "session", "to ");
  session.append(element("b", "", folderOf(sessionRoot)));
  session.title = sessionTitle(sessionRoot);
  const toggle = element("button", "toggle");
  toggle.type = "button";
  toggle.addEventListener("click", () => handlers.toggle());
  head.append(dot, name, count, toggle, session);
  const list = element("div", "list");
  const foot = element("div", "foot");
  const status = element("div", "status");
  status.setAttribute("role", "status");
  const send = element("button", "send");
  send.type = "button";
  send.addEventListener("click", () => handlers.sendAll());
  foot.append(status, send);
  panel.append(head, list, foot);

  root.append(layer, panel);
  shadow.append(style, root);
  hoverBox.hidden = true;
  hoverTag.hidden = true;
  dragBox.hidden = true;

  // What happens in the overlay stays there: the app's own listeners, past the window's capture, never see it.
  for (const type of [
    "pointerdown",
    "pointerup",
    "mousedown",
    "mouseup",
    "click",
    "dblclick",
    "keydown",
    "keyup",
    "keypress",
    "input",
  ]) {
    host.addEventListener(type, (event) => event.stopPropagation());
  }

  document.documentElement.append(host);

  const drawMarks = (boxes: readonly Box[], className: string): HTMLElement[] =>
    boxes.map((box) => {
      const mark = element("div", className);
      place(mark, box);

      return mark;
    });

  return {
    host,
    setOn: (on) => {
      toggle.textContent = on ? "Stop · Alt+P" : "Point · Alt+P";
      toggle.classList.toggle("on", on);
    },
    setAdding: (adding) => {
      root.classList.toggle("adding", adding);
    },
    hover: (box, label) => {
      hoverBox.hidden = box === null;
      hoverTag.hidden = box === null;

      if (box === null) return;
      place(hoverBox, box);
      hoverTag.textContent = label;
      hoverTag.style.left = `${Math.max(0, box.x)}px`;
      hoverTag.style.top = `${Math.max(0, box.y - 20)}px`;
    },
    drag: (box) => {
      dragBox.hidden = box === null;

      if (box !== null) place(dragBox, box);
    },
    marks: (draft, preview) => {
      marksLayer.replaceChildren(...drawMarks(draft, "box"), ...drawMarks(preview, "box preview"));
    },
    openComposer: (near, text, typed, pinned) => {
      summary.textContent = text;
      unpin.hidden = pinned === null;

      if (!composer.isConnected) {
        note.value = typed;
        root.append(composer);
      }

      moveComposer(
        pinned === null ? composerSpot(near, composerSize(), windowSize()) : inView(pinned),
      );
      note.focus();

      return note;
    },
    closeComposer: () => {
      drag = null;
      composer.classList.remove("moving");
      composer.remove();
      note.value = "";
    },
    composerNote: () => note.value,
    shakeComposer: () => {
      composer.classList.remove("shake");
      void composer.offsetWidth;
      composer.classList.add("shake");
    },
    renderTray: (tray, connected, on) => {
      dot.classList.toggle("up", connected);
      dot.title = connected
        ? "Connected to the session's server"
        : "The session's server does not answer";
      count.textContent = tray.items.length === 0 ? "" : `${tray.items.length} in batch`;
      send.textContent = sendText(tray.items.length, on);
      send.disabled = tray.items.length === 0 || tray.status.kind === "sending";
      const said = statusText(tray.status);
      status.textContent = said;
      status.hidden = said === "";
      status.classList.toggle(
        "err",
        tray.status.kind === "failed" ||
          tray.status.kind === "dropped" ||
          tray.status.kind === "unknown",
      );

      list.replaceChildren(
        ...tray.items.map((item) => {
          const card = element("div", "card");
          card.tabIndex = 0;
          card.addEventListener("pointerenter", () => handlers.preview(item.id));
          card.addEventListener("pointerleave", () => handlers.preview(null));
          card.addEventListener("focusin", () => handlers.preview(item.id));
          card.addEventListener("focusout", () => handlers.preview(null));
          const what = element("div", "summary", summaryOf(item.selection.targets));
          const { label } = item.selection;
          const words = element("div", "note", item.selection.note);
          const actions = element("div", "actions");
          const one = element("button", "", "Send");
          one.type = "button";
          one.addEventListener("click", () => handlers.sendOne(item.id));
          const drop = element("button", "", "Remove");
          drop.type = "button";
          drop.addEventListener("click", () => handlers.remove(item.id));
          actions.append(one, drop);
          card.append(
            what,
            ...(label === null ? [] : [element("div", "label", label)]),
            words,
            actions,
          );

          return card;
        }),
      );

      const open = on || tray.items.length > 0 || said !== "";
      list.hidden = !open || tray.items.length === 0;
      foot.hidden = !open;
    },
  };
}
