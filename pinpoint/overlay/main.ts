import type { Box, Target, ZoneImage } from "../shared/wire.ts";
import { captureZone } from "./capture.ts";
import { channelOf } from "./channel.ts";
import { baseOf, pinnedFrom, pointingFrom } from "./config.ts";
import {
  appContext,
  boxOf,
  elementAt,
  infoOf,
  pageInfo,
  scrollOf,
  shortLabel,
  zoneElements,
} from "./page.ts";
import { boxBetween, pageBox, type Press, pressAfter, viewportBox } from "./pick.ts";
import {
  accepted,
  add,
  awaits,
  EMPTY,
  failed,
  givenUp,
  type HeldTarget,
  imaged,
  type Item,
  previewOf,
  ready,
  remove,
  restored,
  sending,
  settle,
  summaryOf,
  type Tray,
  WAITING,
} from "./tray.ts";
import { createView, type Spot } from "./view.ts";

/** Written in by the server that builds the overlay (`buildOverlay`): the session it sends to. */
declare const PINPOINT_ROOT: string;

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

/** How long a send waits for the images still on their way; a zone whose image is not in by then says so. */
const IMAGE_WAIT_MS = 10_000;

/** The app sees none of these while picking is on: a pick is not a click on the app. */
const BLOCKED = ["mousedown", "mouseup", "mousemove", "click", "dblclick", "auxclick"];

const PICKING = "pinpoint-picking";

/** Where a picked target is drawn: an element is measured again, a zone's box in page pixels follows the scroll. */
type Mark = Element | Box;

type ZoneTarget = Extract<Target, { readonly kind: "zone" }>;

type Failed = Extract<ZoneImage, { readonly failed: string }>;

/** A zone drawn as the page showed it at the pick, or why it could not be. */
type Shot = { readonly png: Blob } | Failed;

/**
 * A zone's shot is taken at the pick and handed to the server only once the selection is in the
 * batch and still there: a zone dropped meanwhile leaves nothing on disk.
 */
type Picked =
  | { readonly target: Extract<Target, { readonly kind: "element" }>; readonly mark: Mark }
  | {
      readonly target: Omit<ZoneTarget, "image">;
      readonly shot: Promise<Shot>;
      readonly mark: Mark;
    };

function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function failure(cause: unknown): Failed {
  return { failed: reasonOf(cause) };
}

type Mode =
  | { readonly kind: "off" }
  | {
      readonly kind: "on";
      readonly press: Press | null;
      /** The selection the composer writes, `null` while it is closed. */
      readonly draft: readonly Picked[] | null;
    };

function markBox(mark: Mark): Box {
  return mark instanceof Element ? boxOf(mark) : viewportBox(mark, scrollOf());
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

  const view = createView(PINPOINT_ROOT, {
    toggle: () => toggle(),
    label: (label) => addDraft(label),
    sendAll: () => sendAll(),
    sendOne: (id) => send([id]),
    remove: (id) => {
      arriving.delete(id);
      update(remove(tray, id));
    },
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
        : previewOf(item.selection, scrollOf());

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

  /** The selections whose zone images are on their way, each settled once they are all in or said failed. */
  const arriving = new Map<string, Promise<unknown>>();

  /** Puts the selection being written in the batch at once; its zones' images follow. */
  function addDraft(label: string | null): void {
    if (mode.kind !== "on" || mode.draft === null) return;
    const note = view.composerNote().trim();

    if (label === null && note === "") {
      view.shakeComposer();

      return;
    }

    const { draft } = mode;
    made += 1;
    const id = `${Date.now().toString(36)}-${made}`;

    const targets = draft.map((picked): HeldTarget =>
      "shot" in picked ? { ...picked.target, image: WAITING } : picked.target,
    );

    const item: Item = {
      id,
      selection: { label, note, targets, page: pageInfo(), context: appContext() },
    };

    closeDraft();
    update(add(tray, item));

    const shots = draft.flatMap((picked, index) =>
      "shot" in picked ? [bring(id, index, picked.shot)] : [],
    );

    if (shots.length > 0) arriving.set(id, Promise.allSettled(shots));
  }

  /** Hands the shot of target `index` of item `id` to the server once drawn, and puts what came of it on the card. */
  async function bring(id: string, index: number, shot: Promise<Shot>): Promise<void> {
    const drawn = await shot;

    // The card was removed, or the send gave its image up: nothing goes to the server.
    if (!awaits(tray, id, index)) return;

    const image: ZoneImage =
      "png" in drawn
        ? await channel.image(drawn.png).then((imageId) => ({ id: imageId }), failure)
        : drawn;

    const next = imaged(tray, id, index, image);

    if (next !== tray) update(next);
  }

  /** Settles once the images of `ids` are in, or `IMAGE_WAIT_MS` passed: each still on its way then says so. */
  async function imagesIn(ids: readonly string[]): Promise<void> {
    const waits = ids.flatMap((id) => arriving.get(id) ?? []);

    if (waits.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const late = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, IMAGE_WAIT_MS);
    });

    try {
      await Promise.race([Promise.all(waits), late]);
    } finally {
      clearTimeout(timer);
    }

    for (const id of ids) arriving.delete(id);
    const next = givenUp(tray, ids, `not in within ${IMAGE_WAIT_MS / 1000} s of the send`);

    if (next !== tray) update(next);
  }

  function sendAll(): void {
    send(tray.items.map((item) => item.id));
  }

  /** Sends the items `ids`, once their images are in; the batch says it is sending meanwhile. */
  function send(ids: readonly string[]): void {
    const count = tray.items.filter((item) => ids.includes(item.id)).length;

    if (count === 0 || tray.status.kind === "sending") return;
    update(sending(tray, count));

    void imagesIn(ids).then(() => {
      // A card removed while the images were awaited is not sent.
      const items = tray.items.filter((item) => ids.includes(item.id));

      if (items.length === 0) {
        update({ ...tray, status: EMPTY.status });

        return;
      }

      return channel.send(items.map((item) => ready(item.selection))).then(
        (seq) => {
          update(accepted(tray, ids, seq));
          askLater();
        },
        (cause: unknown) => update(failed(tray, reasonOf(cause))),
      );
    });
  }

  function pick(press: Press, at: { readonly x: number; readonly y: number }): void {
    if (mode.kind !== "on") return;
    const box = boxBetween(press, at);
    let picked: Picked;

    if (box.width > DRAG || box.height > DRAG) {
      const elements = zoneElements(box, view.host).map((element) => infoOf(element));
      const onPage = pageBox(box, scrollOf());

      const shot = captureZone(onPage, view.host).then((png): Shot => ({ png }), failure);
      picked = { target: { kind: "zone", box: onPage, elements }, shot, mark: onPage };
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
    if (mode.kind === "off") return;
    const at = { x: event.clientX, y: event.clientY };
    const inside = event.composedPath().includes(view.host);

    const { press, picks } = pressAfter(mode.press, {
      ...at,
      type: event.type,
      inside,
      button: event.button,
      adding: event.ctrlKey || event.metaKey,
    });

    if (mode.press !== null && press === null) view.drag(null);
    mode = { ...mode, press };

    if (inside) return;
    event.preventDefault();
    event.stopImmediatePropagation();

    if (event.type === "pointerdown") {
      view.hover(null, "");
    } else if (event.type === "pointermove") {
      if (press === null) {
        const under = elementAt(at.x, at.y, view.host);
        view.hover(under === null ? null : boxOf(under), under === null ? "" : shortLabel(under));
      } else {
        view.drag(boxBetween(press, at));
      }
    } else if (picks !== null) {
      pick(picks, at);
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
      sendAll();

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

  for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"] as const) {
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
  throw new Error(
    "pinpoint: overlay.js runs as the classic <script> the session's server adds to each page",
  );
}

// A page that loads the overlay twice (two tags, a dev server's reload) keeps the first one.
if (document.querySelector("pinpoint-overlay") === null) start(script);
