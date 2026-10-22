/* oxlint-disable anti-slop/no-unknown-parameters -- the values typed `unknown` here are what a `catch` or a rejected promise hands over, and the JSON of threads.json, which readThreads parses: there is no earlier place to narrow them. */
// The page's entry (atlas.html loads it; serve.ts bundles it). It draws the map it is given,
// atlas:map and atlas:config, which serve.ts resolves to the files of a map folder; it holds no
// content: a new node, link or text belongs in the map's data.
//
// One view at a time shares one SVG: the view of the open container (view.ts), laid out on a layer
// of its own the first time the reader reaches it and kept (draw.ts, stage.ts), laid out again
// when the drawing area's aspect or the fonts change. Clicks and keys become navigation events
// (navigation.ts): the place changes, the camera (camera.ts) carries the reader from the box of
// the child in the parent's view into the child's view and back, cross-fading the two on the way,
// and the panel follows. There is no free zoom or drag.
//
// Nothing in the data has a position or a size, and nothing should get one: ELK and libavoid lay
// each view out (draw.ts). Text is measured from the rendered fonts (measure.ts), so layout waits
// for them (start).
import config from "atlas:config";
import map from "atlas:map";

import type { Camera, Image, Key } from "./camera.ts";
import { betweenOf, camera, shown } from "./camera.ts";
import type { Drawn, Packing } from "./draw.ts";
import { drawView } from "./draw.ts";
import { drawableOf } from "./drawable.ts";
import type { Rect } from "./geometry.ts";
import { legendHtml, legendKeys } from "./legend.ts";
import { fontKey } from "./measure.ts";
import type { Place, PlaceEvent } from "./navigation.ts";
import { HOME, hashOf, navigate, openOf, placeOfHash } from "./navigation.ts";
import type { ThreadState } from "./panel.ts";
import { renderCrumbs, renderOpenList, renderPanel } from "./panel.ts";
import type { PaletteRule } from "./settings.ts";
import { paletteRules } from "./settings.ts";
import type { Priority, Stage, StageEvent } from "./stage.ts";
import { EMPTY, freshOf, heldOf, nextOf, stage } from "./stage.ts";
import { defs, el, esc } from "./svg.ts";
import { TOKEN_HEADER, TOKEN_META, readThreads } from "./threads.ts";
import { chainOf, holds } from "./tree.ts";
import { coupledIn, lights, viewOf } from "./view.ts";
import type { Selected } from "./wire.ts";
import { SELECTION_PATH } from "./wire.ts";

const { tree, settings } = drawableOf(map, config);

const words = settings.words;

function byId<E extends Element>(id: string, kind: new () => E): E {
  const e = document.querySelector(`#${id}`);

  if (!(e instanceof kind)) {
    throw new TypeError(`atlas.html: #${id} is missing or not a ${kind.name}`);
  }

  return e;
}

const svg = byId("map", SVGSVGElement);

const panel = byId("panel", HTMLElement);

const crumbs = byId("crumbs", HTMLElement);

const openButton = byId("btn-open", HTMLButtonElement);

const openList = byId("open-list", HTMLElement);

const legendButton = byId("btn-legend", HTMLButtonElement);

const legend = byId("legend", HTMLDivElement);

function styleOf(sheet: CSSStyleSheet, rule: PaletteRule): CSSStyleDeclaration {
  const text =
    rule.media === null ? `${rule.selector} {}` : `@media ${rule.media} { ${rule.selector} {} }`;

  const added = sheet.cssRules[sheet.insertRule(text, sheet.cssRules.length)];
  const style = added instanceof CSSMediaRule ? added.cssRules[0] : added;

  if (!(style instanceof CSSStyleRule)) {
    throw new TypeError(`palette: ${text} made no style rule`);
  }

  return style.style;
}

// settings.ts keeps a swatch to the shape of a colour; only the browser knows every value it draws.
function applyPalette(): void {
  const swatches = [
    ...Object.entries(settings.palette).map(([key, swatch]) => [`palette ${key}`, swatch] as const),
    ["openColor", settings.openColor] as const,
  ];

  for (const [name, swatch] of swatches) {
    for (const shade of ["light", "dark"] as const) {
      if (!CSS.supports("color", swatch[shade])) {
        throw new Error(`${name}.${shade}: "${swatch[shade]}" is not a colour this browser draws`);
      }
    }
  }

  const element = document.createElement("style");
  document.head.append(element);
  const { sheet } = element;

  if (sheet === null) {
    throw new TypeError("palette: a <style> in the document has no sheet");
  }

  for (const rule of paletteRules(settings.palette, settings.openColor)) {
    const style = styleOf(sheet, rule);

    for (const [name, value] of rule.properties) {
      style.setProperty(name, value);
    }
  }
}

// The page holds no word of its own and no colour of the map: they come from the Config, and are
// in place before the first layout measures the drawing area. The palette is applied as start()
// begins, so a swatch the browser refuses shows in the panel.
function dressPage(): void {
  document.documentElement.lang = settings.lang;
  document.title = settings.title;
  byId("title", HTMLElement).textContent = settings.title;
  const subtitle = byId("subtitle", HTMLElement);

  if (settings.subtitle === null) {
    subtitle.remove();
  } else {
    subtitle.textContent = settings.subtitle;
  }

  openButton.textContent = words.openPoints;
  openList.setAttribute("aria-label", words.openPoints);
  crumbs.setAttribute("aria-label", words.position);
  byId("stage", HTMLElement).setAttribute("aria-label", words.stage);
  svg.setAttribute("aria-label", words.mapLabel(settings.title));
  byId("btn-home", HTMLButtonElement).textContent = words.home;
  legendButton.textContent = words.legendButton;
  byId("btn-panel", HTMLButtonElement).textContent = words.panelButton;
  byId("hint", HTMLElement).textContent = words.hint;
  legend.setAttribute("aria-label", words.legendButton);
}

dressPage();

// serve.ts answers it from the map folder, and takes a reply posted to it.
const THREADS_URL = "threads.json";

const token = document.querySelector(`meta[name="${TOKEN_META}"]`)?.getAttribute("content") ?? "";

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

const DUR = 700;

const PAD = 12;

defs(svg);

const grid = el("rect", { fill: "url(#grid)" }, svg);

let st: Stage<Drawn> = EMPTY;

let place: Place = HOME;

let cam: Camera | null = null;

let raf = 0;

let turn = 0;

let builtFonts = "";

let builtAspect = 1;

let threads: ThreadState = { kind: "ok", threads: {} };

let panelAvoidError: string | null = null;

// The camera is the SVG viewBox, always at the aspect of the element, so nothing is letterboxed.
// paint() draws the image the camera returns, frame by frame.
function aspect(): number {
  const r = svg.getBoundingClientRect();

  return r.width > 0 && r.height > 0 ? r.width / r.height : 1.4;
}

function fit(r: Rect, pad: number): Rect {
  const a = aspect();
  const w = r.w + 2 * pad;
  const h = r.h + 2 * pad;

  if (w / h < a) {
    return { x: r.x - pad - (h * a - w) / 2, y: r.y - pad, w: h * a, h };
  }

  return { x: r.x - pad, y: r.y - pad - (w / a - h) / 2, w, h: w / a };
}

function drawn(key: Key): Drawn {
  const d = heldOf(st, key);

  if (d === null) {
    throw new Error(`the view of ${key ?? "the root"} is not drawn`);
  }

  return d;
}

const parentOf = (id: string): Key => chainOf(tree, id).at(-2) ?? null;

const between = betweenOf({
  chainOf: (key) => (key === null ? [] : chainOf(tree, key)),
  anchorOf: (id) => {
    const box = drawn(parentOf(id)).rects.get(id);

    if (box === undefined) {
      throw new Error(`the view of ${parentOf(id) ?? "the root"} has no box ${id}`);
    }

    return { box, frame: drawn(id).frame };
  },
});

const packing = (): Packing =>
  settings.ratio === "screen"
    ? { kind: "screen", aspect: builtAspect }
    : { kind: "fixed", ratio: settings.ratio };

// The grid rect covers the largest view held, with room around it for the camera's fit.
function coverGrid(): void {
  const sizes = [...st.held.values()].map((h) => h.drawn.size);
  const w = Math.max(0, ...sizes.map((s) => s.w));
  const h = Math.max(0, ...sizes.map((s) => s.h));
  grid.setAttribute("x", String(-w));
  grid.setAttribute("y", String(-h * 2));
  grid.setAttribute("width", String(w * 3));
  grid.setAttribute("height", String(h * 5));
}

// One layout at a time, in the stage's order; each layout's end wakes whoever waits on the stage.
let landed = Promise.withResolvers<void>();

function dispatch(ev: StageEvent<Drawn>): void {
  st = stage(st, ev);
  pump();
}

function settled(error: unknown): void {
  const waiters = landed;
  landed = Promise.withResolvers<void>();

  if (error === null) {
    waiters.resolve();
  } else {
    waiters.reject(error);
  }
}

// A view laid out again replaces the layer it had once the new one is painted, so the stage never
// shows an empty sheet; the camera re-fits a view whose size changed under it.
function replaced(key: Key, previous: Drawn | null): void {
  coverGrid();

  if (cam !== null && shown(cam, performance.now()).space === key) {
    jumpTo(key);
  }

  previous?.layer.remove();
}

function pump(): void {
  const next = nextOf(st);

  if (next === null) {
    return;
  }

  const { key } = next;
  dispatch({ type: "start" });
  const gen = st.gen;
  const name = key ?? "root";
  const layer = el("g", { style: "visibility: hidden" }, svg);
  performance.mark(`atlas:draw ${name}:start`);

  drawView(viewOf(tree, key), layer, packing(), settings.pins, words, send).then(
    (d) => {
      performance.measure(`atlas:draw ${name}`, `atlas:draw ${name}:start`);
      const previous = heldOf(st, key);
      dispatch({ type: "done", key, gen, drawn: d });

      if (heldOf(st, key) === d) {
        replaced(key, previous);
      } else {
        layer.remove();
      }

      settled(null);
    },
    (error: unknown) => {
      layer.remove();
      dispatch({ type: "failed" });
      settled(error);
    },
  );
}

async function ready(key: Key, priority: Priority): Promise<Drawn> {
  for (;;) {
    const d = freshOf(st, key);

    if (d !== null) {
      return d;
    }

    dispatch({ type: "want", key, priority });
    await landed.promise;
  }
}

const chainKeys = (key: Key): Key[] => [null, ...(key === null ? [] : chainOf(tree, key))];

const imageOf = (key: Key): Image => {
  const { size } = drawn(key);

  return { space: key, vb: fit({ x: 0, y: 0, ...size }, PAD), op: 1, other: null };
};

function paintLayer(layer: SVGGElement, op: number, transform: string): void {
  layer.style.opacity = String(op);
  layer.style.visibility = op > 0 ? "visible" : "hidden";
  layer.style.pointerEvents = op >= 0.5 ? "auto" : "none";

  if (transform === "") {
    layer.removeAttribute("transform");
  } else {
    layer.setAttribute("transform", transform);
  }
}

// The layers painted last: a frame touches the image's own layers and hides those that left it.
let painted = new Set<SVGGElement>();

function paint(img: Image): void {
  svg.setAttribute("viewBox", `${img.vb.x} ${img.vb.y} ${img.vb.w} ${img.vb.h}`);
  const own = drawn(img.space).layer;
  paintLayer(own, img.op, "");
  const now = new Set([own]);

  if (img.other !== null) {
    const s = between(img.other.space, img.space);
    const other = drawn(img.other.space).layer;
    paintLayer(other, img.other.op, `translate(${s.dx},${s.dy}) scale(${s.k})`);
    now.add(other);
  }

  for (const layer of painted) {
    if (!now.has(layer)) {
      paintLayer(layer, 0, "");
    }
  }

  painted = now;
}

// A move's last frame re-fits the view: the drawing area may have changed size on the way.
function frame(): void {
  raf = 0;

  if (cam === null) {
    return;
  }

  const now = performance.now();
  cam = camera(cam, { type: "tick", now }, between);

  if (cam.kind === "moving") {
    paint(shown(cam, now));
    raf = requestAnimationFrame(frame);
  } else {
    jumpTo(cam.image.space);
  }
}

function jumpTo(key: Key): void {
  const image = imageOf(key);
  cam = { kind: "idle", image };
  paint(image);
}

// A move between a view and one of its ancestors is animated; any other, and the first, lands at
// once.
function moveTo(key: Key, from: Key): void {
  const related =
    from === key ||
    (from !== null && holds(tree, key, from)) ||
    (key !== null && holds(tree, from, key));

  if (cam === null || !related) {
    jumpTo(key);

    return;
  }

  cam = camera(
    cam,
    { type: "go", to: imageOf(key), now: performance.now(), dur: reduced ? 0 : DUR },
    between,
  );

  if (raf === 0) {
    raf = requestAnimationFrame(frame);
  }
}

// Selecting a node lights its arrows and outlines its couplings, lifted to the view's items.
function highlight(d: Drawn, p: Place): void {
  const selected = p.selected;
  const coupled = selected === null ? [] : coupledIn(tree, d.view, selected);

  for (const [id, gs] of d.items) {
    for (const g of gs) {
      g.classList.toggle("selected", id === selected);
      g.classList.toggle("coupled", coupled.includes(id));
    }
  }

  for (const e of d.arrows) {
    const hot = selected !== null && lights(tree, e.arrow, selected);
    e.g.classList.toggle("hot", hot);
    const m = hot ? "url(#arr-hot)" : e.marker;
    e.path.setAttribute("marker-end", m);

    if (e.arrow.two) {
      e.path.setAttribute("marker-start", m);
    }
  }

  d.layer.classList.toggle("selecting", selected !== null);
}

// Arrows rest faded; hovering a box, a card, a chip or a pill lights the arrows that touch it and
// fades the others further. The labels of a lit arrow stay readable.
function hover(target: EventTarget | null): void {
  const d = heldOf(st, openOf(place));

  if (d === null) {
    return;
  }

  const over = target instanceof Element ? target.closest("[data-id]") : null;
  // oxlint-disable-next-line unicorn/prefer-dom-node-dataset -- closest() answers an `Element`, which has no `dataset`: only its HTML and SVG kinds do.
  const id = over?.getAttribute("data-id") ?? null;

  for (const e of d.arrows) {
    e.g.classList.toggle("lit", id !== null && lights(tree, e.arrow, id));
  }

  d.layer.classList.toggle("focusing", id !== null);
}

svg.addEventListener("pointerover", (e) => {
  hover(e.target);
});

svg.addEventListener("pointerleave", () => {
  hover(null);
});

function renderLegend(key: Key): void {
  const keys = legendKeys(viewOf(tree, key).legend);
  legend.innerHTML = legendHtml(keys, settings.legend);
  legend.classList.toggle("empty", keys.length === 0);
}

// serve.ts prints each selection, with the map's own label, for the agent's session (wire.ts); a
// page reloaded on a #id posts it again, so a revived server's session hears it too.
let toldSelection: string | null = null;

function tellSelection(id: string | null): void {
  if (id === toldSelection) {
    return;
  }

  toldSelection = id;
  const selection: Selected = { id };

  fetch(SELECTION_PATH, {
    method: "POST",
    headers: { "content-type": "application/json", [TOKEN_HEADER]: token },
    body: JSON.stringify(selection),
  }).then(
    async (response) => {
      if (!response.ok) {
        console.warn(`${SELECTION_PATH}: ${response.status} ${await response.text()}`);
      }
    },
    (error: unknown) => {
      console.warn(`${SELECTION_PATH}: ${failure(error)}`);
    },
  );
}

// The panel, the breadcrumb and the legend follow the place at once; the drawing, once its view
// is laid out (settle).
function render(): void {
  const key = openOf(place);
  panelAvoidError = heldOf(st, key)?.avoidError ?? null;
  renderPanel(settings, tree, panel, place, panelAvoidError, threads);
  renderOpenList(settings, tree, openButton, openList, threads);
  renderCrumbs(settings, tree, crumbs, place);
  renderLegend(key);
  // Keeps the place in the URL's fragment so a link reopens the same view.
  const fragment = hashOf(tree, place);

  history.replaceState(
    null,
    "",
    fragment === "" ? location.pathname + location.search : `#${fragment}`,
  );

  tellSelection(place.selected ?? key);
}

// Renders again, keeping the panel where the reader is and what they were typing.
function rerender(): void {
  const top = panel.scrollTop;

  const typed = [...panel.querySelectorAll("form.reply")].flatMap((form) => {
    const input = form.querySelector("input");

    return form instanceof HTMLFormElement && input !== null && input.value !== ""
      ? [[form.dataset["open"] ?? "", input.value] as const]
      : [];
  });

  render();

  for (const [open, value] of typed) {
    const input = panel.querySelector(`form.reply[data-open="${CSS.escape(open)}"] input`);

    if (input instanceof HTMLInputElement) {
      input.value = value;
    }
  }

  panel.scrollTop = top;
}

// The views beside the open one, laid out while the reader looks: its parent, for the way up,
// then its container children, for the way down.
function prefetch(key: Key): void {
  const next = [
    ...(key === null ? [] : [parentOf(key)]),
    ...viewOf(tree, key).boxes.flatMap((b): string[] => (b.kind === "container" ? [b.id] : [])),
  ];

  for (const k of next) {
    dispatch({ type: "want", key: k, priority: "later" });
  }
}

// The navigated view is laid out first; the views along the path to the one shown follow, which a
// cross-fade aligns on; a later navigation drops this one. The panel, rendered before the view
// was laid out, is rendered again when the view says what it could not: that libavoid failed.
async function settle(): Promise<void> {
  const seq = ++turn;
  const from = cam === null ? null : shown(cam, performance.now()).space;
  const key = openOf(place);
  const d = await ready(key, "now");

  if (cam !== null && from !== key) {
    for (const k of [...chainKeys(key), ...chainKeys(from)]) {
      await ready(k, "now");
    }
  }

  if (seq !== turn) {
    return;
  }

  if (key !== from || cam === null) {
    moveTo(key, from);
  }

  highlight(d, place);

  if (d.avoidError !== panelAvoidError) {
    rerender();
  }

  prefetch(key);
}

// Every input becomes a navigation event: the place changes, the panel follows, the camera heads
// to the view once it is drawn.
function send(ev: PlaceEvent): void {
  place = navigate(tree, place, ev);
  render();
  settle().catch(fail);
}

// threads.json is read at start and each time the window regains focus (an agent replies from the
// terminal); a reply from the page is POSTed to serve.ts with the token it wrote into the page,
// and it answers the updated threads.
const failure = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function threadState(raw: unknown): ThreadState {
  const read = readThreads(raw);

  return read.errors.length > 0
    ? { kind: "error", message: read.errors.join(" · ") }
    : { kind: "ok", threads: read.threads };
}

async function loadThreads(): Promise<ThreadState> {
  try {
    const response = await fetch(THREADS_URL, { cache: "no-store" });

    if (!response.ok) {
      throw new Error(`${THREADS_URL}: HTTP ${response.status}`);
    }

    return threadState(await response.json());
  } catch (error: unknown) {
    return { kind: "error", message: failure(error) };
  }
}

function showThreads(next: ThreadState): void {
  threads = next;
  rerender();
}

async function sendReply(form: HTMLFormElement): Promise<void> {
  const input = form.elements.namedItem("text");
  const button = form.querySelector("button");

  if (!(input instanceof HTMLInputElement) || button === null) {
    throw new TypeError("panel.ts: a reply form needs its text input and its button");
  }

  button.disabled = true;

  try {
    const response = await fetch(THREADS_URL, {
      method: "POST",
      headers: { "content-type": "application/json", [TOKEN_HEADER]: token },
      body: JSON.stringify({ id: form.dataset["open"] ?? "", text: input.value }),
    });

    if (!response.ok) {
      throw new Error(`${response.status} ${await response.text()}`);
    }

    showThreads(threadState(await response.json()));
  } catch (error: unknown) {
    form.querySelector(".reply-error")?.remove();
    form.insertAdjacentHTML(
      "beforeend",
      `<p class="reply-error">${words.replyRefused(esc(failure(error)))}</p>`,
    );
    button.disabled = false;
  }
}

panel.addEventListener("submit", (e) => {
  if (e.target instanceof HTMLFormElement && e.target.classList.contains("reply")) {
    e.preventDefault();
    void sendReply(e.target);
  }
});

addEventListener("focus", () => {
  void loadThreads().then((next) => {
    if (cam !== null && JSON.stringify(next) !== JSON.stringify(threads)) {
      showThreads(next);
    }
  });
});

document.addEventListener("click", (e) => {
  const b = e.target instanceof Element ? e.target.closest("[data-go]") : null;

  if (
    b instanceof HTMLElement &&
    (panel.contains(b) || crumbs.contains(b) || openList.contains(b))
  ) {
    openList.hidePopover();
    const id = b.dataset["go"] ?? "";
    send(id === "" ? { type: "home" } : { type: "jump", id });
  }
});

byId("btn-home", HTMLButtonElement).addEventListener("click", () => {
  send({ type: "home" });
});

// A button that shows or hides an element, remembered per browser. When storage is blocked, the
// element starts shown and the button still works for the visit.
function bindToggle(button: HTMLButtonElement, target: HTMLElement, key: string): void {
  const show = (visible: boolean): void => {
    target.hidden = !visible;
    button.setAttribute("aria-pressed", String(visible));
  };

  try {
    show(localStorage.getItem(key) !== "hidden");
  } catch {
    show(true);
  }

  button.addEventListener("click", () => {
    const visible = target.hidden !== false;
    show(visible);

    try {
      localStorage.setItem(key, visible ? "shown" : "hidden");
    } catch {
      // Blocked storage: the choice lasts for this visit only.
    }
  });
}

bindToggle(legendButton, legend, "atlas.legend");

bindToggle(byId("btn-panel", HTMLButtonElement), panel, "atlas.panel");

document.addEventListener("keydown", (e) => {
  const typing = e.target instanceof HTMLInputElement;

  if (
    e.key === "Escape" &&
    !typing &&
    !openList.matches(":popover-open") &&
    place !== navigate(tree, place, { type: "escape" })
  ) {
    send({ type: "escape" });
  }
});

// render() writes the fragment with replaceState, which fires no hashchange: this is a fragment
// typed into the address bar.
addEventListener("hashchange", () => {
  place = placeOfHash(tree, location.hash);
  render();
  settle().catch(fail);
});

svg.addEventListener("click", () => {
  if (place !== navigate(tree, place, { type: "escape" })) {
    send({ type: "escape" });
  }
});

// The packed views are laid out again when the aspect of the drawing area moves by more than
// RELAYOUT (a resized window, the panel hidden or shown), once the resizing settles, with the
// Config's overview ratio "screen"; every view is when the fonts settle late. A move under way
// ends where it was going.
const RELAYOUT = { change: 0.15, settleMs: 300 };

let relayoutTimer: ReturnType<typeof setTimeout> | undefined;

function relayout(stale: (d: Drawn) => boolean): void {
  if (cam?.kind === "moving") {
    cam = { kind: "idle", image: cam.to };
    paint(cam.image);
  }

  dispatch({ type: "relayout", stale });
  builtFonts = fontKey();
  builtAspect = aspect();
  settle().catch(fail);
}

function relayoutIfNeeded(): void {
  if (
    cam === null ||
    settings.ratio !== "screen" ||
    Math.abs(aspect() - builtAspect) / builtAspect < RELAYOUT.change
  ) {
    return;
  }

  relayout((d) => d.mode === "packed");
}

new ResizeObserver(() => {
  if (cam?.kind === "idle") {
    jumpTo(cam.image.space);
  }

  clearTimeout(relayoutTimer);
  relayoutTimer = setTimeout(relayoutIfNeeded, RELAYOUT.settleMs);
}).observe(svg);

// Fonts: the measure must use the faces the page renders with, so layout waits for them.
// document.fonts.ready alone is not enough: it only waits for faces already requested, and Google
// Fonts splits each weight into unicode-range subsets, fetched on first use. So each face is loaded
// with the text the map shows. A face that still arrives late (slow network) changes the measured
// widths: everything is then laid out again.
const FACES = [
  '600 16px "Barlow Condensed"',
  '700 16px "Barlow Condensed"',
  '400 12px "IBM Plex Mono"',
];

const shownText = (): string =>
  [
    ...new Set(
      [
        ...[...tree.nodes.values()].flatMap((n) => [n.label, n.label.toUpperCase(), n.sub]),
        ...tree.map.links.map((l) => l.label),
      ].join(""),
    ),
  ].join("");

async function start(): Promise<void> {
  applyPalette();
  const text = shownText();
  await Promise.all(FACES.map((f) => document.fonts.load(f, text)));
  await document.fonts.ready;
  builtFonts = fontKey();
  builtAspect = aspect();
  threads = await loadThreads();
  place = placeOfHash(tree, location.hash);
  render();
  await settle();
  document.fonts.addEventListener("loadingdone", () => {
    if (fontKey() !== builtFonts) {
      relayout(() => true);
    }
  });
}

function fail(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  panel.innerHTML = `<p class="warn">${words.drawFailed(esc(message))}</p>`;
  console.error(err);
}

// oxlint-disable-next-line unicorn/prefer-top-level-await -- an await here would hold the entry module's evaluation until the fonts load and the layout ends; the page starts as a chain, and fail() shows what broke.
start().catch(fail);
