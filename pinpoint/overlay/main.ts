import type { Box, Selection, Target } from "../shared/wire.ts";
import { channelOf } from "./channel.ts";
import { baseOf, labelsFrom, pinnedFrom, pointingFrom } from "./config.ts";
import {
  appContext,
  boxOf,
  elementAt,
  infoOf,
  pageInfo,
  shortLabel,
  zoneElements,
} from "./page.ts";
import { boxBetween } from "./pick.ts";
import {
  accepted,
  add,
  EMPTY,
  failed,
  type Item,
  remove,
  restored,
  sending,
  settle,
  summaryOf,
  type Tray,
} from "./tray.ts";
import { createView, type Spot } from "./view.ts";

/**
 * The overlay's controller, the script the server serves as `overlay.js`: Alt+P turns picking on;
 * a click picks an element, a drag a zone, Ctrl (⌘) adds to the selection being written; Enter
 * puts it in the batch, Ctrl+Enter sends the batch. While picking is on, the app sees no pointer.
 */

/** A press that moves less than this is a click. */
const DRAG = 5;

/** How often a tab asks what became of the batches it sent, while one is not settled. */
const ASK_MS = 1_000;

/** How often a visible tab with no batch waiting asks anyway, so its connection dot stays true. */
const IDLE_ASK_MS = 10_000;

/** The app sees none of these while picking is on: a pick is not a click on the app. */
const BLOCKED = ["mousedown", "mouseup", "mousemove", "click", "dblclick", "auxclick"];

const PICKING = "pinpoint-picking";

type Press = { readonly x: number; readonly y: number; readonly adding: boolean };

/** Where a picked target's box is now: an element is measured again, a zone follows the scroll. */
type Mark = Element | { readonly box: Box; readonly scrollX: number; readonly scrollY: number };

type Picked = { readonly target: Target; readonly mark: Mark };

type Mode =
  | { readonly kind: "off" }
  | {
      readonly kind: "on";
      readonly press: Press | null;
      /** The selection the composer writes, `null` while it is closed. */
      readonly draft: readonly Picked[] | null;
    };

function markBox(mark: Mark): Box {
  if (mark instanceof Element) return boxOf(mark);
  const { box } = mark;

  return {
    ...box,
    x: box.x + mark.scrollX - window.scrollX,
    y: box.y + mark.scrollY - window.scrollY,
  };
}

/** A target as the page drew it when it was picked, moved by how far the page scrolled since. */
function shifted(target: Target, scroll: { readonly x: number; readonly y: number }): Box[] {
  const move = (box: Box): Box => ({
    ...box,
    x: box.x + scroll.x - window.scrollX,
    y: box.y + scroll.y - window.scrollY,
  });

  return target.kind === "element" ? [move(target.element.box)] : [move(target.box)];
}

function start(script: HTMLScriptElement): void {
  const base = baseOf(script.src);
  const storeKey = `pinpoint:${base}`;
  const pointingKey = `${storeKey}:pointing`;
  const pinnedKey = `${storeKey}:pinned`;
  let mode: Mode = { kind: "off" };
  let connected = false;
  let previewed: string | null = null;
  let made = 0;

  const loaded = ((): Tray => {
    try {
      const raw = sessionStorage.getItem(storeKey);

      // SAFETY: this overlay wrote the value, `persist` below, under a key that names its server.
      return raw === null ? EMPTY : restored(JSON.parse(raw) as Pick<Tray, "items" | "sent">);
    } catch {
      return EMPTY;
    }
  })();

  const wasOn = ((): boolean => {
    try {
      return pointingFrom(sessionStorage.getItem(pointingKey));
    } catch {
      return false;
    }
  })();

  let tray = loaded;

  let pinned = ((): Spot | null => {
    try {
      return pinnedFrom(sessionStorage.getItem(pinnedKey));
    } catch {
      return null;
    }
  })();

  const persist = (): void => {
    try {
      sessionStorage.setItem(pointingKey, mode.kind);
      sessionStorage.setItem(storeKey, JSON.stringify({ items: tray.items, sent: tray.sent }));

      if (pinned === null) sessionStorage.removeItem(pinnedKey);
      else sessionStorage.setItem(pinnedKey, `${pinned.x},${pinned.y}`);
    } catch {
      // Storage refused (a private window, a quota): the batch, pointing and the composer's pin live as long as the page.
    }
  };

  const view = createView(labelsFrom(script.dataset.pinpointLabels), {
    toggle: () => toggle(),
    label: (label) => addDraft(label),
    sendAll: () => send(tray.items.map((item) => item.id)),
    sendOne: (id) => send([id]),
    remove: (id) => update(remove(tray, id)),
    preview: (id) => {
      previewed = id;
      drawMarks();
    },
    pin: (spot) => {
      pinned = spot;
      persist();
      showComposer();
    },
  });

  function render(): void {
    view.renderTray(tray, connected, mode.kind === "on");
  }

  function update(next: Tray): void {
    tray = next;
    persist();
    render();
    drawMarks();
  }

  function drawMarks(): void {
    const draft =
      mode.kind === "on" && mode.draft !== null
        ? mode.draft.map((picked) => markBox(picked.mark))
        : [];

    const item = tray.items.find((one) => one.id === previewed);

    const preview =
      item === undefined || item.selection.page.url !== location.href
        ? []
        : item.selection.targets.flatMap((target) => shifted(target, item.selection.page.scroll));

    view.marks(draft, preview);
  }

  const channel = channelOf(base);
  let asking = false;
  let nextAsk: ReturnType<typeof setTimeout> | undefined;

  /** Asks what became of the batches this tab sent and are not settled yet; the answer, or none, sets the dot. */
  async function ask(): Promise<void> {
    clearTimeout(nextAsk);
    asking = true;

    try {
      const outcomes = await channel.outcomes(tray.sent.map((one) => one.seq));
      const next = (outcomes ?? []).reduce((from, outcome) => settle(from, outcome), tray);
      const up = outcomes !== null;

      if (next !== tray || up !== connected) {
        connected = up;
        update(next);
      }
    } finally {
      asking = false;
      askLater();
    }
  }

  function askLater(): void {
    if (asking) return;
    clearTimeout(nextAsk);

    if (tray.sent.length > 0) nextAsk = setTimeout(() => void ask(), ASK_MS);
    else if (document.visibilityState === "visible")
      nextAsk = setTimeout(() => void ask(), IDLE_ASK_MS);
  }

  function showComposer(): void {
    if (mode.kind !== "on" || mode.draft === null) return;
    const last = mode.draft.at(-1);

    if (last === undefined) return;
    view.openComposer(
      markBox(last.mark),
      summaryOf(mode.draft.map((one) => one.target)),
      view.composerNote(),
      pinned,
    );
  }

  function closeDraft(): void {
    if (mode.kind === "on") mode = { ...mode, draft: null };
    view.closeComposer();
    drawMarks();
  }

  function setOn(on: boolean): void {
    if (!on) closeDraft();
    mode = on ? { kind: "on", press: null, draft: null } : { kind: "off" };
    persist();
    document.documentElement.classList.toggle(PICKING, on);
    view.setOn(on);
    view.setAdding(false);
    view.hover(null, "");
    view.drag(null);
    render();
  }

  function toggle(): void {
    setOn(mode.kind === "off");
  }

  /** Puts the selection being written in the batch; `false` when it says nothing yet. */
  function addDraft(label: string | null): boolean {
    if (mode.kind !== "on" || mode.draft === null) return false;
    const note = view.composerNote().trim();

    if (label === null && note === "") {
      view.shakeComposer();

      return false;
    }

    const selection: Selection = {
      label,
      note,
      targets: mode.draft.map((picked) => picked.target),
      page: pageInfo(),
      context: appContext(),
    };

    made += 1;
    const item: Item = { id: `${Date.now().toString(36)}-${made}`, selection };
    closeDraft();
    update(add(tray, item));

    return true;
  }

  function send(ids: readonly string[]): void {
    const items = tray.items.filter((item) => ids.includes(item.id));

    if (items.length === 0 || tray.status.kind === "sending") return;
    update(sending(tray, items.length));

    channel.send(items.map((item) => item.selection)).then(
      (seq) => {
        update(accepted(tray, ids, seq));
        askLater();
      },
      (cause: unknown) =>
        update(failed(tray, cause instanceof Error ? cause.message : String(cause))),
    );
  }

  function pick(press: Press, at: { readonly x: number; readonly y: number }): void {
    if (mode.kind !== "on") return;
    const box = boxBetween(press, at);
    let picked: Picked;

    if (box.width > DRAG || box.height > DRAG) {
      const elements = zoneElements(box, view.host).map((element) => infoOf(element));
      picked = {
        target: { kind: "zone", box, elements },
        mark: { box, scrollX: window.scrollX, scrollY: window.scrollY },
      };
    } else {
      const element = elementAt(at.x, at.y, view.host);

      if (element === null) return;
      picked = { target: { kind: "element", element: infoOf(element) }, mark: element };
    }

    const draft = press.adding && mode.draft !== null ? [...mode.draft, picked] : [picked];
    mode = { ...mode, draft };
    showComposer();
    drawMarks();
  }

  function onPointer(event: PointerEvent): void {
    if (mode.kind === "off" || event.composedPath().includes(view.host)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const at = { x: event.clientX, y: event.clientY };

    if (event.type === "pointerdown") {
      if (event.button === 0)
        mode = { ...mode, press: { ...at, adding: event.ctrlKey || event.metaKey } };
      view.hover(null, "");
    } else if (event.type === "pointermove") {
      if (mode.press === null) {
        const under = elementAt(at.x, at.y, view.host);
        view.hover(under === null ? null : boxOf(under), under === null ? "" : shortLabel(under));
      } else {
        view.drag(boxBetween(mode.press, at));
      }
    } else if (mode.press !== null) {
      const { press } = mode;
      mode = { ...mode, press: null };
      view.drag(null);
      pick(press, at);
    }
  }

  function onModifier(event: KeyboardEvent): void {
    view.setAdding(mode.kind === "on" && (event.ctrlKey || event.metaKey));
  }

  function onKey(event: KeyboardEvent): void {
    onModifier(event);
    const inside = event.composedPath().includes(view.host);

    const stop = (): void => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    if (event.altKey && event.code === "KeyP") {
      stop();
      toggle();

      return;
    }

    if (mode.kind === "off") return;

    if (event.key === "Escape") {
      stop();

      if (mode.draft === null) setOn(false);
      else closeDraft();

      return;
    }

    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      stop();

      if (mode.draft !== null && view.composerNote().trim() !== "") addDraft(null);
      send(tray.items.map((item) => item.id));

      return;
    }

    if (
      inside &&
      event.key === "Enter" &&
      !event.shiftKey &&
      event.composedPath()[0] instanceof HTMLTextAreaElement
    ) {
      stop();
      addDraft(null);

      return;
    }

    // What is typed in the composer never reaches the app's shortcuts.
    if (inside) event.stopImmediatePropagation();
  }

  for (const type of ["pointerdown", "pointermove", "pointerup"] as const) {
    window.addEventListener(type, onPointer, { capture: true });
  }

  function block(event: Event): void {
    if (mode.kind === "on" && !event.composedPath().includes(view.host)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }

  for (const type of BLOCKED) window.addEventListener(type, block, { capture: true });

  window.addEventListener("keydown", onKey, { capture: true });
  window.addEventListener("keyup", onModifier, { capture: true });
  window.addEventListener("blur", () => view.setAdding(false));
  window.addEventListener("scroll", drawMarks, { capture: true, passive: true });
  window.addEventListener(
    "resize",
    () => {
      drawMarks();

      if (pinned !== null) showComposer();
    },
    { passive: true },
  );

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !asking) void ask();
  });

  const cursor = document.createElement("style");
  cursor.textContent = `html.${PICKING}, html.${PICKING} * { cursor: crosshair !important; }`;
  document.head.append(cursor);
  setOn(wasOn);
  void ask();
}

const script = document.currentScript;

if (!(script instanceof HTMLScriptElement)) {
  throw new Error("pinpoint: overlay.js runs as a classic <script>, which the Vite plugin injects");
}

// A page that loads the overlay twice (two tags, a dev server's reload) keeps the first one.
if (document.querySelector("pinpoint-overlay") === null) start(script);
