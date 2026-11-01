/* oxlint-disable anti-slop/no-unknown-parameters -- the values typed `unknown` here are what a `catch` or a rejected promise hands over, the JSON of threads.json, which readThreads parses, and the lines serve.ts answers, which isSourceLines parses: there is no earlier place to narrow them. */
// The page's entry (atlas.html loads it; serve.ts bundles it). It draws the map it is given,
// atlas:map and atlas:config, which serve.ts resolves to the files of a map folder; it holds no
// content: a new node, link or text belongs in the map's data.
//
// One view at a time shares one SVG: the view of the open container (view.ts), laid out on a layer
// of its own the first time the reader reaches it and kept (draw.ts, stage.ts), laid out again
// when the drawing area's aspect or the fonts change. Clicks and keys become navigation events
// (navigation.ts): the place changes, the camera (camera.ts) carries the reader from the box of
// the child in the parent's view into the child's view and back, cross-fading the two on the way,
// and the panel follows. Inside a view, the wheel zooms, a drag pans, two fingers pinch and a mouse
// resting near an edge slides a zoomed view that way, all within the view's fit (zoom.ts).
//
// Nothing in the data has a position or a size, and nothing should get one: ELK and libavoid lay
// each view out (draw.ts). Text is measured from the rendered fonts (measure.ts), so layout waits
// for them (start).
import config from "atlas:config";
import map from "atlas:map";

import type { Journey } from "../model/atlas.ts";
import { cardsOf } from "../model/cards.ts";
import type { Citation } from "../model/citations.ts";
import { citationOf, citationText, mapCitations } from "../model/citations.ts";
import { drawableOf } from "../model/drawable.ts";
import type { EntryStep, Numbered, Traced } from "../model/journeys.ts";
import {
  RANGE_DASH,
  RANGE_JOINT,
  formAfter,
  formBefore,
  indexOf,
  isEntry,
  journeyOf,
  rangeText,
  rangesOf,
  rangesText,
  representativeIn,
  stepsOf,
  tracedIn,
} from "../model/journeys.ts";
import type { Mode, PageState, Params, Place, PlaceEvent, Scope } from "../model/navigation.ts";
import {
  DEFAULTS,
  HOME,
  navigate,
  openOf,
  pageStateOf,
  paramsAfter,
  paramsOfHash,
  placeOfHash,
  shownPlace,
} from "../model/navigation.ts";
import type { Dimmed } from "../model/phases.ts";
import { arrowDimmed, dimmedBy, dimsIn, labelAt } from "../model/phases.ts";
import type { PaletteRule } from "../model/settings.ts";
import { paletteRules } from "../model/settings.ts";
import { TOKEN_HEADER, TOKEN_META, readThreads } from "../model/threads.ts";
import { chainOf, holds, nodeOf } from "../model/tree.ts";
import { coupledIn, lights, viewOf } from "../model/view.ts";
import type { Selected, SourceLines } from "../server/wire.ts";
import { SELECTION_PATH, SOURCE_PATH } from "../server/wire.ts";
import type { Camera, Image, Key } from "./camera.ts";
import { betweenOf, camera, shown } from "./camera.ts";
import type { Drawn, Packing } from "./draw.ts";
import { drawView, relabel } from "./draw.ts";
import type { Point, Rect } from "./geometry.ts";
import { legendHtml, legendKeys } from "./legend.ts";
import { fontKey, textWidth } from "./measure.ts";
import type { LineSpan, Stretch, ThreadState, Viewer } from "./panel.ts";
import {
  ICONS,
  cardsHtml,
  journeysHtml,
  lineLabel,
  linesAround,
  renderCrumbs,
  renderJourney,
  renderOpenList,
  renderPanel,
  renderViewer,
} from "./panel.ts";
import type { Copies } from "./placement.ts";
import type { Span } from "./ribbon.ts";
import { cellMark, covers, ribbonHtml, stepLine } from "./ribbon.ts";
import type { Priority, Stage, StageEvent } from "./stage.ts";
import { EMPTY, freshOf, heldOf, nextOf, stage } from "./stage.ts";
import { defs, el, esc, text as svgText } from "./svg.ts";
import type { Course, Curve, Head, Pinned } from "./trace.ts";
import {
  TRAVEL,
  coursesOf,
  formAt,
  frameOf,
  headOf,
  headPx,
  lengthOf,
  pathOf,
  pointAt,
  travelled,
} from "./trace.ts";
import { captionShown, edgePush, panned, pushed, strayed, zoomed } from "./zoom.ts";

const { tree, settings } = drawableOf(map, config);

const scope: Scope = { tree, phases: settings.phases };

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

const sourcesButton = byId("btn-sources", HTMLButtonElement);

const drawing = byId("sheet", HTMLDivElement);

const cardsView = byId("cards", HTMLDivElement);

const modeSwitch = byId("mode", HTMLSpanElement);

const mapButton = byId("btn-map", HTMLButtonElement);

const cardsButton = byId("btn-cards", HTMLButtonElement);

const cameraSwitch = byId("camera", HTMLSpanElement);

const stepper = byId("phases", HTMLDivElement);

const journeysButton = byId("btn-journeys", HTMLButtonElement);

const journeyList = byId("journey-list", HTMLElement);

const stageBox = byId("stage", HTMLElement);

const ribbon = byId("ribbon", HTMLElement);

const ribbonSteps = byId("ribbon-steps", HTMLDivElement);

const playButton = byId("btn-play", HTMLButtonElement);

// The journeys the header's menu plays: each the root declares with a step, the first of an id.
const journeys = (tree.map.root.journeys ?? []).filter((j) => journeyOf(tree, j.id) === j);

const steps = [null, ...settings.phases].map(
  (phase): readonly [string | null, HTMLButtonElement] => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = phase ?? words.allPhases;

    return [phase, button];
  },
);

// What the camera frames on a journey: the whole view a step is played in, the steps of its
// section traced there, or the step alone.
type CameraMode = "plan" | "section" | "step";

const CAMERA_MODES: readonly CameraMode[] = ["plan", "section", "step"];

const cameraButtons = CAMERA_MODES.map((mode): readonly [CameraMode, HTMLButtonElement] => [
  mode,
  byId(`btn-camera-${mode}`, HTMLButtonElement),
]);

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
  stageBox.setAttribute("aria-label", words.stage);
  svg.setAttribute("aria-label", words.mapLabel(settings.title));
  byId("btn-home", HTMLButtonElement).textContent = words.home;
  byId("btn-fit", HTMLButtonElement).textContent = words.fitButton;
  legendButton.textContent = words.legendButton;
  byId("btn-panel", HTMLButtonElement).textContent = words.panelButton;
  mapButton.textContent = words.mapButton;
  cardsButton.textContent = words.cardsButton;
  byId("hint", HTMLElement).textContent = words.hint;
  legend.setAttribute("aria-label", words.legendButton);

  if (mapCitations(map).length === 0) {
    sourcesButton.remove();
  } else {
    sourcesButton.textContent = words.sourcesButton;
    sourcesButton.title = words.sourcesTitle;
  }

  if (settings.phases.length === 0) {
    stepper.remove();
  } else {
    stepper.setAttribute("aria-label", words.phasesLabel);
    stepper.title = words.phasesTitle;
    stepper.append(...steps.map(([, button]) => button));
  }

  if (journeys.length === 0) {
    journeysButton.remove();
    journeyList.remove();
  } else {
    journeysButton.textContent = words.journeysButton;
    journeysButton.title = words.journeysTitle;
    journeyList.setAttribute("aria-label", words.journeysButton);
    ribbon.setAttribute("aria-label", words.ribbonLabel);
    playButton.textContent = words.play;
    byId("camera-label", HTMLSpanElement).textContent = words.cameraLabel;

    for (const [mode, button] of cameraButtons) {
      button.textContent = words.camera[mode];
    }
  }
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

// The rest of the reading state the fragment carries (navigation.ts's grammar).
let params: Params = DEFAULTS;

// The place the page shows: the reader's, or on a journey the view its step is played in, the
// reader's place then being where the journey started (shownPlace). A hover asks it at each move
// of the pointer, and a journey's host view reads every end of its steps: it is kept until the
// place or the parameters change.
let hereFor: { readonly place: Place; readonly params: Params; readonly shown: Place } | null =
  null;

function here(): Place {
  if (hereFor?.place !== place || hereFor.params !== params) {
    hereFor = { place, params, shown: shownPlace(scope, place, params) };
  }

  return hereFor.shown;
}

let cam: Camera | null = null;

let raf = 0;

let turn = 0;

let builtFonts = "";

let builtAspect = 1;

let threads: ThreadState = { kind: "ok", threads: {} };

let panelAvoidError: string | null = null;

// The panel shows each citation as a marker of its lines, or in full once the reader asks.
let sourcesInFull = false;

// The lines of the marker last clicked, shown in place of the panel's fields until the reader
// closes them or moves; panelTop is where the panel was scrolled when they opened, openedFrom the
// marker they opened from, in the panel or the cards, which takes the focus back when they close.
let viewer: Viewer | null = null;

let panelTop = 0;

let openedFrom: Mark | null = null;

// The camera is the SVG viewBox, always at the aspect of the element, so nothing is letterboxed.
// paint() draws the image the camera returns, frame by frame.
function aspect(): number {
  const r = svg.getBoundingClientRect();

  return r.width > 0 && r.height > 0 ? r.width / r.height : 1.4;
}

// The share of the drawing area's height above the ribbon, which floats over its foot on a
// journey and leaves its size alone: 1 off a journey.
function aboveRibbon(): number {
  if (ribbon.hidden) {
    return 1;
  }

  const area = svg.getBoundingClientRect();
  const covered = area.bottom - ribbon.getBoundingClientRect().top;

  return covered > 0 && covered < area.height ? 1 - covered / area.height : 1;
}

// A view fits the drawing area above the ribbon: the rect fits that area's aspect, then runs on
// under the ribbon, at the element's.
function fit(r: Rect, pad: number): Rect {
  const a = aspect();
  const share = aboveRibbon();
  const above = a / share;
  const w = r.w + 2 * pad;
  const h = r.h + 2 * pad;

  if (w / h < above) {
    return { x: r.x - pad - (h * above - w) / 2, y: r.y - pad, w: h * above, h: h / share };
  }

  return { x: r.x - pad, y: r.y - pad - (w / above - h) / 2, w, h: w / a };
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

  drawView(
    viewOf(tree, key),
    layer,
    packing(),
    settings.pins,
    settings.direction,
    words,
    send,
  ).then(
    (d) => {
      performance.measure(`atlas:draw ${name}`, `atlas:draw ${name}:start`);
      dimView(d);
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

// A caption too small to read on screen hides, unless its arrow is lit or hot, or its own box or
// card is hovered or selected (captionShown): at the fit of a busy view, labels and sub-titles
// would show at 7 or 8 px. Each layer keeps the scale it was last painted at, which a hover or a
// selection reads.
const scales = new WeakMap<SVGGElement, number>();

function showCaptions(d: Drawn): void {
  const scale = scales.get(d.layer);

  if (scale === undefined) {
    return;
  }

  for (const c of d.captions) {
    const on = (cls: string): boolean => c.owner.classList.contains(cls);
    const lit = on("lit") || on("peer");
    const hot = on("hot") || on("selected");
    c.text.classList.toggle("illegible", !captionShown(c.size, scale, lit, hot));
  }
}

function paintView(d: Drawn, op: number, transform: string, scale: number): void {
  paintLayer(d.layer, op, transform);
  scales.set(d.layer, scale);
  showCaptions(d);

  if (trace?.d === d) {
    placeTrace(performance.now());
  }
}

// The layers painted last: a frame touches the image's own layers and hides those that left it.
let painted = new Set<SVGGElement>();

// The stage's width is read before the viewBox is written, so a frame forces no layout.
function paint(img: Image): void {
  const scale = svg.getBoundingClientRect().width / img.vb.w;
  svg.setAttribute("viewBox", `${img.vb.x} ${img.vb.y} ${img.vb.w} ${img.vb.h}`);
  const own = drawn(img.space);
  paintView(own, img.op, "", scale);
  const now = new Set([own.layer]);

  if (img.other !== null) {
    const s = between(img.other.space, img.space);
    const other = drawn(img.other.space);
    paintView(other, img.other.op, `translate(${s.dx},${s.dy}) scale(${s.k})`, scale * s.k);
    now.add(other.layer);
  }

  for (const layer of painted) {
    if (!now.has(layer)) {
      paintLayer(layer, 0, "");
    }
  }

  painted = now;
}

// A move's last frame lands on the view's rest frame (restOf): the drawing area may have changed
// size on the way.
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
  const image = restOf(key);
  cam = { kind: "idle", image };
  framedBy = framingOf(key);
  paint(image);
  fitButton.disabled = true;
}

// A free look inside the view shown: the wheel zooms around the pointer, a drag pans, two
// pointers pinch, all within the fit (zoom.ts). The fit button, a click on the empty sheet or
// Escape bring the rest frame back (restOf), and a move to another view starts at its own.
const WHEEL = 0.0018;

const WHEEL_LINE = 20;

const DRAG = 4;

const fitButton = byId("btn-fit", HTMLButtonElement);

function look(vb: Rect): void {
  if (cam?.kind !== "idle") {
    return;
  }

  const image = { ...cam.image, vb };
  cam = { kind: "idle", image };
  paint(image);
  fitButton.disabled = !strayed(vb, restOf(image.space).vb);
}

const astray = (): boolean =>
  cam?.kind === "idle" && strayed(cam.image.vb, restOf(cam.image.space).vb);

// Whether the reader looked away from the rest frame; if so, back to it.
function unzoom(): boolean {
  if (cam?.kind !== "idle" || !astray()) {
    return false;
  }

  jumpTo(cam.image.space);

  return true;
}

const unitsPerPx = (vb: Rect): number => vb.w / Math.max(1, svg.getBoundingClientRect().width);

function pointOf(client: Point, vb: Rect): Point {
  const r = svg.getBoundingClientRect();

  return [
    vb.x + ((client[0] - r.left) / Math.max(1, r.width)) * vb.w,
    vb.y + ((client[1] - r.top) / Math.max(1, r.height)) * vb.h,
  ];
}

svg.addEventListener(
  "wheel",
  (e) => {
    if (cam?.kind !== "idle") {
      return;
    }

    e.preventDefault();
    const step = e.deltaMode === WheelEvent.DOM_DELTA_PIXEL ? e.deltaY : e.deltaY * WHEEL_LINE;
    const { vb, space } = cam.image;
    look(
      zoomed(vb, pointOf([e.clientX, e.clientY], vb), Math.exp(step * WHEEL), imageOf(space).vb),
    );
  },
  { passive: false },
);

const pointers = new Map<number, Point>();

const starts = new Map<number, Point>();

let dragged = false;

svg.addEventListener("pointerdown", (e) => {
  if (e.pointerType === "mouse" && e.button !== 0) {
    return;
  }

  if (pointers.size === 0) {
    dragged = false;
  }

  pointers.set(e.pointerId, [e.clientX, e.clientY]);
  starts.set(e.pointerId, [e.clientX, e.clientY]);
});

// Captured only once a drag starts: a capture taken at pointerdown retargets the click to the
// sheet, and no box or card would ever receive it. A pointer a script made up has no capture.
function capture(e: PointerEvent): void {
  if (e.isTrusted && !svg.hasPointerCapture(e.pointerId)) {
    svg.setPointerCapture(e.pointerId);
  }
}

svg.addEventListener("pointermove", (e) => {
  const before = pointers.get(e.pointerId);
  const origin = starts.get(e.pointerId);

  if (before === undefined || origin === undefined || cam?.kind !== "idle") {
    return;
  }

  const now: Point = [e.clientX, e.clientY];
  pointers.set(e.pointerId, now);
  const other = [...pointers].find(([id]) => id !== e.pointerId)?.[1];
  const { vb, space } = cam.image;
  const fitted = imageOf(space).vb;
  const k = unitsPerPx(vb);

  if (other === undefined) {
    if (!dragged && Math.hypot(now[0] - origin[0], now[1] - origin[1]) < DRAG) {
      return;
    }

    dragged = true;
    capture(e);
    look(panned(vb, (now[0] - before[0]) * k, (now[1] - before[1]) * k, fitted));

    return;
  }

  dragged = true;
  capture(e);
  const span = (p: Point): number => Math.hypot(p[0] - other[0], p[1] - other[1]);
  const mid = (p: Point): Point => [(p[0] + other[0]) / 2, (p[1] + other[1]) / 2];
  const [m0, m1] = [mid(before), mid(now)];
  const pinched = zoomed(vb, pointOf(m0, vb), span(before) / Math.max(1, span(now)), fitted);
  look(
    panned(
      pinched,
      (m1[0] - m0[0]) * unitsPerPx(pinched),
      (m1[1] - m0[1]) * unitsPerPx(pinched),
      fitted,
    ),
  );
});

for (const ended of ["pointerup", "pointercancel"] as const) {
  svg.addEventListener(ended, (e) => {
    pointers.delete(e.pointerId);
    starts.delete(e.pointerId);
  });
}

// A drag's end is no click: nothing is selected or left.
svg.addEventListener(
  "click",
  (e) => {
    if (dragged) {
      e.stopPropagation();
      e.preventDefault();
      dragged = false;
    }
  },
  true,
);

fitButton.addEventListener("click", () => {
  unzoom();
});

// A mouse resting near an edge of a view the reader looked into slides it that way, faster the
// closer to the edge, up to EDGE.speed screen px per second, once it rested there EDGE.dwellMs: a
// pass toward the panel or the header moves nothing. At the rest frame (restOf), during a drag or
// a move, or under a touch, nothing slides. On a journey, the bottom edge is the ribbon's top.
const EDGE = { band: 56, speed: 900, dwellMs: 180 };

// The longest gap between two frames that counts, in ms: a tab shown again does not leap.
const FRAME_CAP = 50;

let push: Point = [0, 0];

let pushSince = 0;

let pushLast = 0;

let pushRaf = 0;

function pushFrame(now: number): void {
  pushRaf = 0;

  if (push[0] === 0 && push[1] === 0) {
    return;
  }

  if (now - pushSince >= EDGE.dwellMs && cam?.kind === "idle" && pointers.size === 0) {
    const { vb, space } = cam.image;
    const step = (EDGE.speed * Math.min(now - pushLast, FRAME_CAP) * unitsPerPx(vb)) / 1000;
    const slid = pushed(vb, push, step, imageOf(space).vb);

    if (slid.x !== vb.x || slid.y !== vb.y) {
      look(slid);
    }
  }

  pushLast = now;
  pushRaf = requestAnimationFrame(pushFrame);
}

function setPush(next: Point): void {
  const now = performance.now();

  if (push[0] === 0 && push[1] === 0) {
    pushSince = now;
  }

  push = next;

  if (pushRaf === 0 && (next[0] !== 0 || next[1] !== 0)) {
    pushLast = now;
    pushRaf = requestAnimationFrame(pushFrame);
  }
}

svg.addEventListener("pointermove", (e) => {
  if (e.pointerType !== "mouse" || !astray()) {
    setPush([0, 0]);

    return;
  }

  const r = svg.getBoundingClientRect();
  const bottom = ribbon.hidden ? r.bottom : Math.min(r.bottom, ribbon.getBoundingClientRect().top);
  const area = { x: r.left, y: r.top, w: r.width, h: bottom - r.top };
  setPush(edgePush([e.clientX, e.clientY], area, EDGE.band));
});

svg.addEventListener("pointerleave", () => {
  setPush([0, 0]);
});

// A move to a view's rest frame (restOf): within the view, or between it and one of its
// ancestors, it is animated; any other, and the first, lands at once.
function moveTo(key: Key, from: Key): void {
  const related =
    from === key ||
    (from !== null && holds(tree, key, from)) ||
    (key !== null && holds(tree, from, key));

  if (cam === null || !related) {
    jumpTo(key);

    return;
  }

  framedBy = framingOf(key);

  cam = camera(
    cam,
    { type: "go", to: restOf(key), now: performance.now(), dur: reduced ? 0 : DUR },
    between,
  );

  if (raf === 0) {
    raf = requestAnimationFrame(frame);
  }
}

// The journey played and its step shown, as the page shows them; null off a journey.
type Played = { readonly journey: Journey; readonly at: Numbered };

function playedNow(): Played | null {
  const journey = journeyOf(tree, pageState.journey);
  const at = journey === null ? undefined : stepsOf(journey)[pageState.step - 1];

  return journey === null || at === undefined ? null : { journey, at };
}

// A step of the section shown that a view traces (tracedIn): its course (coursesOf), and for an
// entry the box of its pill, in screen pixels around the top of its start (entryBox).
type Leg = Traced & Course & { readonly entry: Rect | null };

// The copies of what stands for a node in a view: both copies of a ghost or of a card drawn
// twice, and the one rect of any other.
function copiesIn(d: Drawn, id: string): Copies | undefined {
  const r = d.rects.get(id) ?? d.chips.get(id);

  return d.copies.get(id) ?? (r === undefined ? undefined : { in: r, out: r });
}

function legsOf(d: Drawn, played: Played): Leg[] {
  const traced = tracedIn(tree, d.view.id, played.journey, played.at.s);

  const courses = coursesOf(
    traced.map(({ at, from, to }) => ({ from, to, back: at.step.back === true })),
    (id) => copiesIn(d, id),
  );

  return traced.flatMap((t, i): Leg[] => {
    const course = courses[i] ?? null;
    const entry = isEntry(t.at.step) ? entryBox(t.at.step) : null;

    return course === null ? [] : [{ ...t, ...course, entry }];
  });
}

// The legs of the section shown in a view, kept while the view, the journey and the section stay:
// a pointer's move, a turn of the wheel and a push frame ask for the rest frame, which measures
// no text then.
let legsFor: {
  readonly d: Drawn;
  readonly journey: Journey;
  readonly s: number;
  readonly legs: readonly Leg[];
} | null = null;

function legsIn(d: Drawn, played: Played): readonly Leg[] {
  if (legsFor?.d !== d || legsFor.journey !== played.journey || legsFor.s !== played.at.s) {
    legsFor = { d, journey: played.journey, s: played.at.s, legs: legsOf(d, played) };
  }

  return legsFor.legs;
}

// The marks drawn at a constant size on screen, in pixels: a step's number in its circle; a pill
// of text, the data's form of the step shown over its middle and its condition under it; the
// travelling pill, a dot with the data's form beside it; an entry's pill over its start, its
// nature's icon before its text; the pulse around that start, in the view's units.
const ON_SCREEN = {
  number: 8.5,
  pill: { h: 22, pad: 8, gap: 9, whenRadius: 3 },
  traveller: { r: 6.5, dx: 12, dy: -26 },
  entry: { h: 24, pad: 10, icon: 14, after: 4, gap: 6 },
  pulse: 3,
};

const entryText = (step: EntryStep): string =>
  words.entryPill(words.entryKind[step.kind], step.trigger);

function entryBox(step: EntryStep): Rect {
  const { h, pad, icon, after, gap } = ON_SCREEN.entry;
  const w = pad + icon + after + textWidth(entryText(step), "trace-entry-t") + pad;

  return { x: -w / 2, y: -(gap + h), w, h };
}

// An entry's pill stands over the middle of its start's top edge.
const entryAt = ({ a }: Course): Point => [a.x + a.w / 2, a.y];

const FRAME_MARGIN_PX = 60;

// What the camera's mode frames in the view a step is played in: the rects of the
// representatives of the steps it frames and the middle of their curves, and the pill of each
// entry among them. "section" frames every step of the section traced there, so it stays from
// one step to the next; "step", the step shown.
type Framed = { readonly rects: readonly Rect[]; readonly pinned: readonly Pinned[] };

function framedIn(d: Drawn, played: Played): Framed {
  const legs = legsIn(d, played).filter(
    (leg) => cameraMode === "section" || leg.at.n === played.at.n,
  );

  const rects = legs.flatMap((leg): Rect[] => {
    const [x, y] = pointAt(leg.curve, 0.5);

    return [leg.a, leg.b, { x, y, w: 0, h: 0 }];
  });

  const pinned = legs.flatMap(({ entry, ...leg }): Pinned[] =>
    entry === null ? [] : [{ at: entryAt(leg), box: entry }],
  );

  return { rects, pinned };
}

// The rest frame of a view: where a move ends, where a resize or a new layout lands, and what the
// fit button, Escape and a click on the empty sheet bring back (unzoom), the edge push sliding
// only once the reader looked away from it. The view's fit; on a journey, in the view its step is
// played in, the frame of the camera's mode (frameOf), within the fit, above the ribbon.
function restOf(key: Key): Image {
  const image = imageOf(key);
  const played = playedNow();

  if (played === null || cameraMode === "plan" || key !== openOf(here())) {
    return image;
  }

  const { rects, pinned } = framedIn(drawn(key), played);
  const r = svg.getBoundingClientRect();
  const area = { w: r.width, h: r.height };

  return {
    ...image,
    vb: frameOf(rects, pinned, area, aboveRibbon(), FRAME_MARGIN_PX, image.vb),
  };
}

// What sets a view's rest frame, so that a step which keeps it moves no camera: the view, and on
// a journey, in the view its step is played in, the journey, the camera's mode and the section or
// the step that mode frames.
function framingOf(key: Key): string {
  const played = playedNow();

  if (played === null || key !== openOf(here())) {
    return JSON.stringify([key]);
  }

  const by = { plan: 0, section: played.at.s, step: played.at.n }[cameraMode];

  return JSON.stringify([key, played.journey.id, cameraMode, by]);
}

// The framing the camera last moved or jumped to.
let framedBy = "";

// A mark that keeps its size on screen, at `at` in its view's units.
type Pin = { readonly g: SVGGElement; readonly at: Point };

// A step's head is HEAD.strokes widths of its line long on screen, as the markers of the view's
// arrows are (svg.ts), its tip at the curve's end, and never longer than the curve on screen
// (headPx). `path` points along x, HEAD.length long.
const HEAD = { strokes: 5.5, path: "M0 0 L-10 -5 L-10 5 z", length: 10 };

// `line`, its step's, whose width on screen atlas.html sets; `length`, its curve's, in the view's
// units.
type Arrowhead = {
  readonly g: SVGGElement;
  readonly line: SVGPathElement;
  readonly head: Head;
  readonly length: number;
};

// The travelling pill along the step shown: the data's form before the step during the first
// half of its way, then after it (formAt).
type Traveller = {
  readonly g: SVGGElement;
  readonly pill: SVGGElement;
  readonly rect: SVGRectElement;
  readonly label: SVGTextElement;
  readonly curve: Curve;
  readonly before: string | null;
  readonly after: string | null;
};

// The journey's trace, drawn over every item of the view its step is played in; `strokes`, the
// width on screen of each step's line (readStrokes); `since`, when its step showed, which the
// travelling pill sets off from.
type Trace = {
  readonly d: Drawn;
  readonly journey: Journey;
  readonly n: number;
  readonly g: SVGGElement;
  readonly legs: ReadonlyMap<number, SVGGElement>;
  readonly pins: readonly Pin[];
  readonly heads: readonly Arrowhead[];
  readonly strokes: Map<SVGPathElement, number>;
  readonly traveller: Traveller | null;
  readonly since: number;
};

let trace: Trace | null = null;

// Each line's width as atlas.html sets it for its step's marks, read once the trace is drawn and
// again when a cell of the ribbon brings a step out, not at each frame: a head follows its line.
function readStrokes(t: Trace): void {
  for (const { line } of t.heads) {
    t.strokes.set(line, Number.parseFloat(getComputedStyle(line).strokeWidth));
  }
}

let travelRaf = 0;

// The step whose cell of the ribbon the pointer is over, whose trace stands out; null for none.
let peeked: number | null = null;

function pinIn(parent: SVGGElement, cls: string, at: Point, pins: Pin[]): SVGGElement {
  const g = el("g", { class: `${cls} trace-mark` }, parent);
  pins.push({ g, at });

  return g;
}

// A pill of one line of text, `left` its left edge, or centred on 0 when null, and `top` its top.
function pillIn(
  g: SVGGElement,
  cls: string,
  content: string,
  left: number | null,
  top: number,
  radius: number,
): readonly [SVGRectElement, SVGTextElement] {
  const { h, pad } = ON_SCREEN.pill;
  const w = textWidth(content, cls) + 2 * pad;
  const x = left ?? -w / 2;
  const rect = el("rect", { x, y: top, width: w, height: h, rx: radius }, g);
  const label = svgText(g, { x: x + pad, y: top + h / 2, class: cls }, content);

  return [rect, label];
}

// Each step's number at its middle; the step shown's, when it carries a data's form, which a pill
// shows there, only while its cell of the ribbon is under the pointer (atlas.html).
function drawLeg(
  g: SVGGElement,
  leg: Leg,
  current: number,
  carrying: boolean,
  pins: Pin[],
  heads: Arrowhead[],
): SVGGElement {
  const { n, step } = leg.at;
  const back = step.back === true;

  const cls = [
    "trace-step",
    n < current ? "past" : n === current ? "current" : "next",
    ...(back ? ["back"] : []),
    ...(step.when === undefined ? [] : ["when"]),
    ...(n === current && carrying ? ["carrying"] : []),
    ...(n === peeked ? ["peek"] : []),
  ];

  const s = el("g", { class: cls.join(" ") }, g);
  const d = pathOf(leg.curve);
  el("path", { d, class: "trace-halo" }, s);
  // The line and its head fade as one: each faded on its own, the line under the head shows.
  const stroke = el("g", { class: "trace-stroke" }, s);
  const line = el("path", { d, class: "trace-line" }, stroke);
  const head = el("g", { class: "trace-head" }, stroke);
  el("path", { d: HEAD.path }, head);
  heads.push({ g: head, line, head: headOf(leg.curve), length: lengthOf(leg.curve) });
  const badge = pinIn(s, "trace-number", pointAt(leg.curve, 0.5), pins);
  el("circle", { r: ON_SCREEN.number }, badge);
  svgText(badge, { class: "trace-number-t" }, String(n));

  return s;
}

function drawEntry(g: SVGGElement, leg: Leg, step: EntryStep, box: Rect, pins: Pin[]): void {
  const { pad, icon, after } = ON_SCREEN.entry;
  const pill = pinIn(g, "trace-entry", entryAt(leg), pins);
  el("rect", { x: box.x, y: box.y, width: box.w, height: box.h, rx: box.h / 2 }, pill);

  const glyph = el(
    "g",
    { transform: `translate(${box.x + pad} ${box.y + (box.h - icon) / 2})` },
    pill,
  );

  glyph.innerHTML = ICONS[step.kind];
  const x = box.x + pad + icon + after;
  svgText(pill, { x, y: box.y + box.h / 2, class: "trace-entry-t" }, entryText(step));
}

// Each step of the section shown that the view traces, its number at its middle but the step
// shown's when it has a data's form, which a pill shows there, its condition in a pill under it;
// an entry's pill over its start, which pulses; the travelling pill on top.
function drawTrace(d: Drawn, played: Played, since: number): Trace {
  const { journey, at } = played;
  const g = el("g", { class: "trace" }, d.layer);
  const pins: Pin[] = [];
  const heads: Arrowhead[] = [];
  const all = legsIn(d, played);
  const leg = all.find((l) => l.at.n === at.n);
  const form = formAfter(journey, at.n);
  const { h, gap, whenRadius } = ON_SCREEN.pill;

  if (leg !== undefined && isEntry(at.step) && !reduced) {
    const { a } = leg;
    const k = ON_SCREEN.pulse;
    el(
      "rect",
      {
        x: a.x - k,
        y: a.y - k,
        width: a.w + 2 * k,
        height: a.h + 2 * k,
        rx: 6,
        class: "trace-pulse",
      },
      g,
    );
  }

  const legs = new Map(
    all.map((l): [number, SVGGElement] => [
      l.at.n,
      drawLeg(g, l, at.n, form !== null, pins, heads),
    ]),
  );

  if (leg === undefined) {
    return {
      d,
      journey,
      n: at.n,
      g,
      legs,
      pins,
      heads,
      strokes: new Map(),
      traveller: null,
      since,
    };
  }

  const middle = pointAt(leg.curve, 0.5);

  if (form !== null) {
    pillIn(pinIn(g, "trace-form", middle, pins), "trace-form-t", form, null, -(gap + h), h / 2);
  }

  if (at.step.when !== undefined) {
    const when = pinIn(g, "trace-when", middle, pins);
    pillIn(when, "trace-when-t", words.when(at.step.when), null, gap, whenRadius);
  }

  if (isEntry(at.step) && leg.entry !== null) {
    drawEntry(g, leg, at.step, leg.entry, pins);
  }

  const traveller = el("g", { class: "trace-traveller trace-mark" }, g);
  const pill = el("g", { class: "trace-form", display: "none" }, traveller);

  const [rect, label] = pillIn(
    pill,
    "trace-form-t",
    "",
    ON_SCREEN.traveller.dx,
    ON_SCREEN.traveller.dy,
    h / 2,
  );

  el("circle", { r: ON_SCREEN.traveller.r }, traveller);

  return {
    d,
    journey,
    n: at.n,
    g,
    legs,
    pins,
    heads,
    strokes: new Map(),
    traveller: {
      g: traveller,
      pill,
      rect,
      label,
      curve: leg.curve,
      before: formBefore(journey, at.n),
      after: form,
    },
    since,
  };
}

// The travelling pill shows the form it carries at `t`, none when it carries none.
function carry(traveller: Traveller, form: string | null): void {
  if (form === null) {
    traveller.pill.setAttribute("display", "none");

    return;
  }

  traveller.pill.removeAttribute("display");

  if (traveller.label.textContent !== form) {
    traveller.label.textContent = form;
    traveller.rect.setAttribute(
      "width",
      String(textWidth(form, "trace-form-t") + 2 * ON_SCREEN.pill.pad),
    );
  }
}

// Every mark and head at its size on screen, from the scale its layer was last painted at; the
// travelling pill where it is at `now`, at the end of its way under a reduced motion.
function placeTrace(now: number): void {
  if (trace === null) {
    return;
  }

  const pxPerUnit = scales.get(trace.d.layer) ?? 1;
  const perPx = 1 / pxPerUnit;

  const pinAt = (g: SVGGElement, [x, y]: Point): void => {
    g.setAttribute("transform", `translate(${x} ${y}) scale(${perPx})`);
  };

  for (const pin of trace.pins) {
    pinAt(pin.g, pin.at);
  }

  for (const { g, line, head, length } of trace.heads) {
    const width = trace.strokes.get(line) ?? 0;
    const k = (headPx(HEAD.strokes * width, length, pxPerUnit) / HEAD.length) * perPx;
    const [x, y] = head.at;
    g.setAttribute("transform", `translate(${x} ${y}) rotate(${head.angle}) scale(${k})`);
  }

  const { traveller } = trace;

  if (traveller !== null) {
    const t = reduced ? 1 : travelled(now - trace.since);
    carry(traveller, formAt(traveller.before, traveller.after, t));
    pinAt(traveller.g, pointAt(traveller.curve, t));
  }
}

function travelFrame(now: number): void {
  travelRaf = 0;

  if (trace === null) {
    return;
  }

  placeTrace(now);

  if (now - trace.since < TRAVEL.delay + TRAVEL.ms) {
    travelRaf = requestAnimationFrame(travelFrame);
  }
}

// The items the section shown touches, outlined, and the two ends of the step shown, outlined
// darker; the view's other chips, cards and ghosts faded, never a box (atlas.html).
function markItems(
  d: Drawn,
  tracing: boolean,
  touched: ReadonlySet<string>,
  ends: ReadonlySet<string>,
): void {
  for (const [id, gs] of d.items) {
    for (const g of gs) {
      g.classList.toggle("touched", touched.has(id));
      g.classList.toggle("end", ends.has(id));
    }
  }

  d.layer.classList.toggle("tracing", tracing);
}

// On a journey, the view its step is played in traces the step's section, drawn anew when the
// step or the view's layout changes; the travelling pill keeps its way when only the layout does.
// Off a journey, or in another view, no trace.
function showTrace(d: Drawn, played: Played | null): void {
  const at = played !== null && d.view.id === openOf(here()) ? played : null;
  const same = at !== null && trace?.journey === at.journey && trace.n === at.at.n;
  const kept = same ? trace : null;

  if (kept?.d === d) {
    return;
  }

  if (trace !== null) {
    trace.g.remove();
    markItems(trace.d, false, new Set(), new Set());
    trace = null;
  }

  if (at === null) {
    legsFor = null;

    return;
  }

  trace = drawTrace(d, at, kept?.since ?? performance.now());
  const section = stepsOf(at.journey).filter(({ s }) => s === at.at.s);

  const touched = new Set(
    section.flatMap(({ step: { from, to } }) =>
      [from, to].flatMap((end) => representativeIn(tree, d.view.id, end) ?? []),
    ),
  );

  const leg = legsIn(d, at).find((l) => l.at.n === at.at.n);
  markItems(d, true, touched, new Set(leg === undefined ? [] : [leg.from, leg.to]));
  readStrokes(trace);
  placeTrace(performance.now());

  if (!reduced && travelRaf === 0) {
    travelRaf = requestAnimationFrame(travelFrame);
  }
}

function peek(n: number | null): void {
  peeked = n;

  if (trace === null) {
    return;
  }

  for (const [k, g] of trace.legs) {
    g.classList.toggle("peek", k === n);
  }

  readStrokes(trace);
  placeTrace(performance.now());
}

// A box's index, in the view's units as its open points' badge (openBadge): `h` high, centred on
// the box's top edge, its right edge `right` from the box's, or `open` beside that badge.
const INDEX = { cls: "box-index-t", h: 24, pad: 9, right: 16, open: 31 };

// The index badges of the view a step is played in, for the journey and the section they show.
let indexed: {
  readonly d: Drawn;
  readonly journey: Journey;
  readonly s: number;
  readonly badges: readonly SVGGElement[];
} | null = null;

// Each box of the view whose index has a step (indexOf) carries it in ranges (rangesOf), in its
// own group, so that a click on it is one on the box; its tooltip names the box, then each step
// over its ends' labels.
function drawIndex(d: Drawn, played: Played): SVGGElement[] {
  return d.view.boxes.flatMap((box): SVGGElement[] => {
    const index = box.kind === "container" ? indexOf(tree, played.journey, box.id) : [];
    const r = d.rects.get(box.id);
    const g = d.items.get(box.id)?.[0];

    if (index.length === 0 || r === undefined || g === undefined) {
      return [];
    }

    const ranges = rangesOf(index, played.at.s);
    const w = textWidth(rangesText(ranges), INDEX.cls) + 2 * INDEX.pad;
    const x = r.x + r.w - (box.open > 0 ? INDEX.open : INDEX.right) - w;
    const badge = el("g", { class: "box-index" }, g);

    const lines = [
      words.indexTitle(lineLabel(nodeOf(tree, box.id))),
      ...index.map((at) => stepLine(tree, at)),
    ];

    el("title", {}, badge).textContent = lines.join("\n");
    el("rect", { x, y: r.y - INDEX.h / 2, width: w, height: INDEX.h, rx: INDEX.h / 2 }, badge);
    const label = svgText(badge, { x: x + INDEX.pad, y: r.y, class: INDEX.cls }, "");

    for (const [i, range] of ranges.entries()) {
      if (i > 0) {
        label.append(RANGE_JOINT);
      }

      el("tspan", { class: range.mark }, label).textContent = rangeText(range);
    }

    return [badge];
  });
}

// On a journey, the view its step is played in carries the boxes' index, drawn anew when the
// view, its layout, the journey or the section shown changes, and gone off a journey.
function showIndex(d: Drawn, played: Played | null): void {
  if (
    played !== null &&
    indexed?.d === d &&
    indexed.journey === played.journey &&
    indexed.s === played.at.s
  ) {
    return;
  }

  for (const badge of indexed?.badges ?? []) {
    badge.remove();
  }

  indexed =
    played === null
      ? null
      : { d, journey: played.journey, s: played.at.s, badges: drawIndex(d, played) };
}

// Selecting a node lights its arrows, their labels shown at any size, and outlines its couplings,
// lifted to the view's items. A journey's step selects nothing: the view's own arrows stay dimmed
// under its trace (showTrace).
function highlight(d: Drawn, p: Place, played: Played | null): void {
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

  d.layer.classList.toggle("selecting", selected !== null || played !== null);
  showTrace(d, played);
  showIndex(d, played);
  showCaptions(d);
}

// Arrows rest faded; hovering a box, a card, a chip or a pill, or reaching it with Tab, lights the
// arrows that touch it and fades the others further. The labels of a lit arrow stay readable, and
// show at any size, as do the item's own tag and sub-title.
function hover(target: EventTarget | null): void {
  const d = heldOf(st, openOf(here()));

  if (d === null) {
    return;
  }

  const over = target instanceof Element ? target.closest("[data-id]") : null;
  // oxlint-disable-next-line unicorn/prefer-dom-node-dataset -- closest() answers an `Element`, which has no `dataset`: only its HTML and SVG kinds do.
  const id = over?.getAttribute("data-id") ?? null;

  for (const e of d.arrows) {
    e.g.classList.toggle("lit", id !== null && lights(tree, e.arrow, id));
  }

  for (const [itemId, gs] of d.items) {
    for (const g of gs) {
      g.classList.toggle("peer", id !== null && itemId === id);
    }
  }

  d.layer.classList.toggle("focusing", id !== null);
  showCaptions(d);
}

// A click focuses an item too, but only a keyboard's focus is :focus-visible: the mouse alone keeps
// lighting what it hovers.
function focusedItem(): Element | null {
  const active = document.activeElement;
  const layer = heldOf(st, openOf(here()))?.layer;

  return active !== null && layer?.contains(active) === true && active.matches(":focus-visible")
    ? active
    : null;
}

svg.addEventListener("pointerover", (e) => {
  hover(e.target);
});

svg.addEventListener("pointerleave", () => {
  hover(focusedItem());
});

svg.addEventListener("focusin", () => {
  const item = focusedItem();

  if (item !== null) {
    hover(item);
  }
});

svg.addEventListener("focusout", () => {
  hover([...svg.querySelectorAll(":hover")].at(-1) ?? null);
});

// On a journey, the lines of the kinds of steps the view traces: forward, back, under a condition.
function renderLegend(key: Key): void {
  const view = viewOf(tree, key);
  const played = playedNow();
  const traced = played === null ? [] : tracedIn(tree, key, played.journey, played.at.s);

  const keys = legendKeys({
    ...view.legend,
    forward: traced.some(({ at }) => at.step.back !== true),
    back: traced.some(({ at }) => at.step.back === true),
    when: traced.some(({ at }) => at.step.when !== undefined),
    later: dimsIn(dimmed, view),
  });

  legend.innerHTML = legendHtml(keys, settings.legend);
  legend.classList.toggle("empty", keys.length === 0);
}

// The cards start below the controls, on as many lines as the stage's width wraps them to.
const controls = byId("controls", HTMLDivElement);

new ResizeObserver(() => {
  stageBox.style.setProperty(
    "--controls-bottom",
    `${controls.offsetTop + controls.offsetHeight}px`,
  );
}).observe(controls);

// The container whose cards the stage shows, so a render of the same keeps where they were
// scrolled; undefined while the drawing shows.
let cardsShown: Key | undefined;

// An element of a root whose markup is rewritten, found again in the new markup by the value of
// the first of the keys (attributes) it bears, and its rank among the root's elements bearing that
// value.
interface Mark {
  readonly root: Element;
  readonly keys: readonly string[];
  readonly key: string;
  readonly value: string;
  readonly rank: number;
}

const bearing = (root: Element, key: string, value: string): Element[] =>
  [...root.querySelectorAll(`[${key}]`)].filter((e) => e.getAttribute(key) === value);

function markOf(root: Element, keys: readonly string[], element: Element | null): Mark | null {
  if (element === null || !root.contains(element)) {
    return null;
  }

  const key = keys.find((k) => element.hasAttribute(k));

  if (key === undefined) {
    return null;
  }

  const value = element.getAttribute(key) ?? "";

  return { root, keys, key, value, rank: bearing(root, key, value).indexOf(element) };
}

const focusable = (e: Element | undefined): e is HTMLElement =>
  e instanceof HTMLElement && !e.matches(":disabled");

// The marked element takes the focus; gone or disabled, the root's first enabled element bearing
// one of the keys does.
function refocus(mark: Mark): void {
  const same = bearing(mark.root, mark.key, mark.value)[mark.rank];

  const target = focusable(same)
    ? same
    : [...mark.root.querySelectorAll(mark.keys.map((k) => `[${k}]`).join(", "))].find((e) =>
        focusable(e),
      );

  target?.focus({ preventScroll: true });
}

// Rewrites a root's markup, and gives the focus back to what held it there.
function keepingFocus(root: Element, keys: readonly string[], rewrite: () => void): void {
  const mark = markOf(root, keys, document.activeElement);
  rewrite();

  if (mark !== null) {
    refocus(mark);
  }
}

// What the cards' focus is kept by: their headers and their markers.
const CARD_KEYS = ["data-select", "data-cite"];

// The switch shows where the open container has cards (cardsOf), but on a journey, whose trace
// they cannot show, where the camera's modes show in its place; the cards lie over the drawing,
// which stays laid out beneath, out of reach of the pointer and the keyboard (inert), its zoom
// kept for the way back and the fit and legend buttons disabled. The same cards rewritten keep
// where they were scrolled and the focus.
function renderMode(key: Key): void {
  const cards = params.journey === null ? cardsOf(tree, key) : null;
  const table = params.mode === "cards" ? cards : null;
  modeSwitch.hidden = cards === null;
  cameraSwitch.hidden = params.journey === null;
  mapButton.setAttribute("aria-pressed", String(table === null));
  cardsButton.setAttribute("aria-pressed", String(table !== null));
  cardsView.hidden = table === null;
  drawing.inert = table !== null;
  fitButton.disabled = table !== null || !astray();
  legendButton.disabled = table !== null;

  if (table === null) {
    cardsShown = undefined;

    return;
  }

  const same = cardsShown === key;
  const [left, top] = same ? [cardsView.scrollLeft, cardsView.scrollTop] : [0, 0];

  const write = (): void => {
    cardsView.innerHTML = cardsHtml(settings, table, here().selected, dimmed.nodes);
    cardsView.scrollLeft = left;
    cardsView.scrollTop = top;
  };

  if (same) {
    keepingFocus(cardsView, CARD_KEYS, write);
  } else {
    write();
  }

  cardsShown = key;
}

// What the phase picked dims (phases.ts), and the phase it was read for: a view takes it as its
// layout lands (pump), and every view held takes it anew when the phase changes (renderPhase).
let dimmedFor: string | null = null;

let dimmed: Dimmed = dimmedBy(tree, settings.phases, dimmedFor);

function dimView(d: Drawn): void {
  for (const [id, gs] of d.items) {
    for (const g of gs) {
      g.classList.toggle("later", dimmed.nodes.has(id));
    }
  }

  for (const e of d.arrows) {
    e.g.classList.toggle("later", arrowDimmed(dimmed, e.arrow));
    relabel(e, d.mode, labelAt(tree, dimmed, e.arrow));
  }
}

function renderPhase(): void {
  const picked = steps.findIndex(([phase]) => phase === params.phase);

  for (const [i, [, button]] of steps.entries()) {
    button.setAttribute("aria-pressed", String(i === picked));
    button.classList.toggle("later", picked > 0 && i > picked);
  }

  if (params.phase !== dimmedFor) {
    dimmedFor = params.phase;
    dimmed = dimmedBy(tree, settings.phases, dimmedFor);

    for (const { drawn: d } of st.held.values()) {
      dimView(d);
    }
  }
}

// The journey the ribbon was written for, and the step its marks show; null off a journey.
let ribbonShown: { readonly journey: Journey; readonly step: number } | null = null;

const spanOf = (e: HTMLElement): Span => ({
  first: Number(e.dataset["first"]),
  last: Number(e.dataset["last"]),
});

function markRibbon(step: number): void {
  for (const e of ribbonSteps.querySelectorAll("[data-step]")) {
    if (e instanceof HTMLElement) {
      const mark = cellMark(Number(e.dataset["step"]), step);
      e.classList.toggle("past", mark === "past");

      if (mark === "current") {
        e.setAttribute("aria-current", "step");
      } else {
        e.removeAttribute("aria-current");
      }
    }
  }

  for (const e of ribbonSteps.querySelectorAll("[data-first]")) {
    if (e instanceof HTMLElement) {
      e.classList.toggle("current", covers(spanOf(e), step));
    }
  }
}

// The ribbon alone scrolls, not the page, so the step shown's cell is in its sight, inside the
// padding that keeps its focus ring in sight too.
function showCell(step: number): void {
  const cell = ribbonSteps.querySelector(`[data-step="${step}"]`);

  if (cell === null) {
    return;
  }

  const box = ribbonSteps.getBoundingClientRect();
  const { paddingLeft, paddingRight } = getComputedStyle(ribbonSteps);
  const left = box.left + Number.parseFloat(paddingLeft);
  const right = box.right - Number.parseFloat(paddingRight);
  const r = cell.getBoundingClientRect();

  if (r.left < left) {
    ribbonSteps.scrollLeft -= Math.ceil(left - r.left);
  } else if (r.right > right) {
    ribbonSteps.scrollLeft += Math.ceil(r.right - right);
  }
}

// On a journey, the ribbon shows it whole: written once per journey (ribbonHtml), its marks set in
// place at each step, so the focus stays where it was, and the step's cell scrolled into sight.
// A cell written anew, or gone, is under no pointer until the pointer moves: no trace stands out.
function renderRibbon(played: Journey | null, step: number): void {
  ribbon.hidden = played === null;

  if (played === null) {
    ribbonShown = null;
    ribbonSteps.replaceChildren();
    peeked = null;

    return;
  }

  const written = ribbonShown?.journey === played;

  if (!written) {
    ribbonSteps.innerHTML = ribbonHtml(tree, played);
    peeked = null;
  }

  if (!written || ribbonShown?.step !== step) {
    markRibbon(step);
    showCell(step);
  }

  ribbonShown = { journey: played, step };
}

// The ribbon floats over the drawing area, whose size it leaves alone: as it shows, hides or
// changes height, the view fits above it again, and the legend rises above it.
new ResizeObserver(() => {
  stageBox.style.setProperty("--ribbon-height", `${ribbon.offsetHeight}px`);

  if (cam?.kind === "idle") {
    jumpTo(cam.image.space);
  }
}).observe(ribbon);

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

// What an agent reads of the page in its browser, `window.atlas`, without a screenshot: a getter,
// so a page script cannot assign it, answering the frozen state of the last render, the fragment's
// parameters among it, the zoom of the view shown, 1 at its fit, 2 when half its width fills the
// stage, the camera's mode on a journey, whether the panel shows its citations in full, and the
// citation whose lines it shows, if any.
let pageState: PageState = pageStateOf(scope, place, params);

const zoomOf = (): number =>
  cam?.kind === "idle"
    ? Math.round((imageOf(cam.image.space).vb.w / cam.image.vb.w) * 1000) / 1000
    : 1;

Object.defineProperty(window, "atlas", {
  get: () =>
    Object.freeze({
      ...pageState,
      zoom: zoomOf(),
      camera: cameraMode,
      sourcesInFull,
      citation: viewer === null ? null : citationText(viewer.citation),
    }),
  enumerable: true,
});

// The panel, the breadcrumb and the legend follow the place at once; the drawing, once its view
// is laid out (settle). On a journey, the panel shows its step.
function render(): void {
  pageState = pageStateOf(scope, place, params);
  const at = here();
  const key = openOf(at);
  const played = journeyOf(tree, pageState.journey);
  panelAvoidError = heldOf(st, key)?.avoidError ?? null;

  if (viewer !== null) {
    renderViewer(settings, panel, viewer);
  } else if (played === null) {
    renderPanel(settings, tree, panel, at, panelAvoidError, threads);
  } else {
    renderJourney(settings, tree, panel, played, pageState.step, panelAvoidError);
  }

  renderOpenList(settings, tree, openButton, openList, threads);

  if (journeys.length > 0) {
    journeyList.innerHTML = journeysHtml(settings, journeys, pageState.journey);
  }

  renderCrumbs(settings, tree, crumbs, at);
  renderPhase();
  renderLegend(key);
  renderMode(key);
  renderRibbon(played, pageState.step);
  // Keeps the place and its parameters in the URL's fragment so a link reopens the same view.
  const { fragment } = pageState;

  history.replaceState(
    null,
    "",
    fragment === "" ? location.pathname + location.search : `#${fragment}`,
  );

  tellSelection(at.selected ?? key);
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
// cross-fade aligns on; a later navigation drops this one. A view shown anew lights only what the
// keyboard focuses in it: a hover left on it when the reader went elsewhere ended unseen. The
// panel, rendered before the view was laid out, is rendered again when the view says what it could
// not: that libavoid failed.
async function settle(): Promise<void> {
  const seq = ++turn;
  const from = cam === null ? null : shown(cam, performance.now()).space;
  const key = openOf(here());
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
    hover(focusedItem());
  } else if (framingOf(key) !== framedBy) {
    moveTo(key, key);
  }

  highlight(d, here(), playedNow());

  if (d.avoidError !== panelAvoidError) {
    rerender();
  }

  prefetch(key);
}

// Every input becomes a navigation event: the place changes, the panel follows, the camera heads
// to the view once it is drawn. On a journey, the event is read in its step's view, and leaves it,
// its playback stopped.
function send(ev: PlaceEvent): void {
  stopPlayback();
  const from = here();
  const next = navigate(tree, from, ev);
  params = paramsAfter(scope, from, next, params);
  place = next;
  viewer = null;
  render();
  settle().catch(fail);
}

// Shows a journey's step; the reader's place and mode stay where the journey started, which
// leaving returns to. The step shows as a drawing, the cards being unable to show its arrow
// (renderMode), and a phase picked stays.
function showStep(journey: string | null, step: number): void {
  params = { ...params, journey, step };
  viewer = null;
  render();
  settle().catch(fail);
}

// The reader plays a journey's step, picked from the menu (its first), a panel button, an arrow
// key or a cell of the ribbon, or leaves the journey: its playback stops.
function play(journey: string | null, step: number): void {
  stopPlayback();
  showStep(journey, step);
}

const leave = (): void => {
  play(DEFAULTS.journey, DEFAULTS.step);
};

// Moves the reader, rewriting the panel, and gives the focus it held back (keepingFocus), the
// panel scrolled to show it, so a reader on the keyboard goes on from where they were.
function keepingPanelFocus(keys: readonly string[], move: () => void): void {
  keepingFocus(panel, keys, move);
  const active = document.activeElement;

  if (active !== null && panel.contains(active)) {
    active.scrollIntoView({ block: "nearest" });
  }
}

// The panel's ← → buttons, the tour's or a journey's: the focus goes to the same side's new copy,
// or to the other one when that copy is disabled.
const NAV_KEYS = ["data-nav"];

// Leaving a journey: the focus goes to the first marker or button that moves the reader in the
// panel of the place it started from, not to its reply fields, where Escape and the arrows type.
const LEAVE_KEYS = ["data-leave", "data-cite", "data-go"];

// The step before or after the one shown, while there is one; past either end, the playback stops
// all the same.
function stepBy(delta: number): void {
  stopPlayback();
  const played = journeyOf(tree, pageState.journey);
  const next = pageState.step + delta;

  if (played !== null && next >= 1 && next <= stepsOf(played).length) {
    play(played.id, next);
  }
}

// The ribbon's play button plays the journey on from the step shown, a step every PLAY_MS, and
// stops at its last; pressed on the last, it starts again from the first. A step the reader plays,
// a fragment typed into the address bar and a move stop it; a phase picked does not.
const PLAY_MS = 2000;

let playback: ReturnType<typeof setInterval> | undefined;

// The button's word changes its width, and the steps' sight with it.
function markPlayback(): void {
  const on = playback !== undefined;
  playButton.textContent = on ? words.pause : words.play;
  playButton.setAttribute("aria-pressed", String(on));

  if (ribbonShown !== null) {
    showCell(ribbonShown.step);
  }
}

function stopPlayback(): void {
  clearInterval(playback);
  playback = undefined;
  markPlayback();
}

// What render() rewrites, each with the keys its focus is found again by: the panel's ← → and
// leave buttons, the breadcrumb's crumbs, the rows of the journeys' and the open points' lists.
// The ribbon, written once per journey, keeps its own.
const REWRITTEN = [
  [panel, ["data-nav", "data-leave"]],
  [crumbs, ["data-go"]],
  [journeyList, ["data-journey"]],
  [openList, ["data-go"]],
] as const;

// The root's own box scrolls, never the page, so the element is in its sight: renderJourney
// scrolls the panel back to its top.
function inSightOf(root: Element, e: Element): void {
  const top = root.getBoundingClientRect().top + root.clientTop;
  const bottom = top + root.clientHeight;
  const r = e.getBoundingClientRect();

  if (r.top < top) {
    root.scrollTop -= Math.ceil(top - r.top);
  } else if (r.bottom > bottom) {
    root.scrollTop += Math.ceil(r.bottom - bottom);
  }
}

// A step the playback shows, or a cell of the ribbon plays, leaves the focus where it was, on the
// new copy of what held it, in sight within its own box but with the page left where it was: on
// a phone, where the page scrolls, the map stays in sight.
function keepingFocusInPlace(move: () => void): void {
  const active = document.activeElement;
  const marks = REWRITTEN.flatMap(([root, keys]) => markOf(root, keys, active) ?? []);
  move();

  for (const mark of marks) {
    refocus(mark);
    const focused = document.activeElement;

    if (focused !== null && mark.root.contains(focused)) {
      inSightOf(mark.root, focused);
    }
  }
}

function tick(): void {
  const played = journeyOf(tree, pageState.journey);
  const count = played === null ? 0 : stepsOf(played).length;
  const next = pageState.step + 1;

  if (played === null || next > count) {
    stopPlayback();

    return;
  }

  keepingFocusInPlace(() => {
    showStep(played.id, next);
  });

  if (next === count) {
    stopPlayback();
  }
}

function togglePlayback(): void {
  const played = journeyOf(tree, pageState.journey);

  if (played === null || playback !== undefined) {
    stopPlayback();

    return;
  }

  const count = stepsOf(played).length;

  if (pageState.step === count) {
    keepingFocusInPlace(() => {
      showStep(played.id, 1);
    });
  }

  if (pageState.step < count) {
    playback = setInterval(tick, PLAY_MS);
  }

  markPlayback();
}

playButton.addEventListener("click", togglePlayback);

// A cell of the ribbon plays its step, the focus where it was before. A pointer's press would move
// it to the cell in some browsers and not in others: it moves it in none. A key on a focused cell
// plays it, the focus kept on the cell.
ribbonSteps.addEventListener("mousedown", (e) => {
  if (e.target instanceof Element && e.target.closest("[data-step]") !== null) {
    e.preventDefault();
  }
});

ribbonSteps.addEventListener("click", (e) => {
  const cell = e.target instanceof Element ? e.target.closest("[data-step]") : null;

  if (cell instanceof HTMLElement) {
    keepingFocusInPlace(() => {
      play(pageState.journey, Number(cell.dataset["step"]));
    });
  }
});

// The pointer over a cell brings its step's trace out, when the view traces it.
ribbonSteps.addEventListener("pointerover", (e) => {
  const cell = e.target instanceof Element ? e.target.closest("[data-step]") : null;
  peek(cell instanceof HTMLElement ? Number(cell.dataset["step"]) : null);
});

ribbonSteps.addEventListener("pointerleave", () => {
  peek(null);
});

// The header's lists, each with the button that opens it under itself (atlas.html).
const lists = [
  [openButton, openList],
  [journeysButton, journeyList],
] as const;

for (const [button, list] of lists) {
  list.addEventListener("beforetoggle", (e) => {
    if (e.newState === "open") {
      const r = button.getBoundingClientRect();
      list.style.setProperty("--list-left", `${r.left}px`);
      list.style.setProperty("--list-top", `${r.bottom + 6}px`);
    }
  });
}

// A press outside an open list closes it (the popover's light dismiss); the click that press ends
// only closes it: it selects, enters, leaves or opens nothing. A click from the keyboard has no
// press.
let dismissing = false;

document.addEventListener(
  "pointerdown",
  (e) => {
    const target = e.target instanceof Node ? e.target : null;

    dismissing = lists.some(
      ([button, list]) =>
        list.matches(":popover-open") && !list.contains(target) && !button.contains(target),
    );
  },
  true,
);

document.addEventListener(
  "click",
  (e) => {
    if (dismissing && e.detail > 0) {
      e.stopPropagation();
      e.preventDefault();
    }

    dismissing = false;
  },
  true,
);

journeyList.addEventListener("click", (e) => {
  const row = e.target instanceof Element ? e.target.closest("[data-journey]") : null;

  if (row instanceof HTMLElement) {
    journeyList.hidePopover();
    play(row.dataset["journey"] ?? "", 1);
  }
});

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

// A marker is a button only with the Config's sources root (panel.ts): a click asks serve.ts for
// the lines around the cited ones, and shows them in the panel until the reader closes them.
/* oxlint-disable anti-slop/no-runtime-typeof -- isSourceLines IS the boundary parser of what serve.ts answers the page: there is no earlier place to narrow it. */
const isSourceLines = (v: unknown): v is SourceLines =>
  typeof v === "object" &&
  v !== null &&
  "lines" in v &&
  Array.isArray(v.lines) &&
  v.lines.every((line) => typeof line === "string");
/* oxlint-enable anti-slop/no-runtime-typeof */

// The route answers 413 for a file over its cap, which the viewer names as too large to show.
async function stretchOf(path: string, { from, to }: LineSpan): Promise<Stretch | "large"> {
  const query = new URLSearchParams({ path, from: String(from), to: String(to) });
  const response = await fetch(`${SOURCE_PATH}?${query}`, { cache: "no-store" });

  if (response.status === 413) {
    return "large";
  }

  if (!response.ok) {
    throw new Error(`${response.status} ${await response.text()}`);
  }

  const answer: unknown = await response.json();

  if (!isSourceLines(answer)) {
    throw new TypeError(`${SOURCE_PATH}: the answer holds no lines`);
  }

  return { from, lines: answer.lines };
}

async function linesOf(citation: Citation): Promise<Viewer> {
  try {
    const read = await Promise.all(
      linesAround(citation).map(async (span) => await stretchOf(citation.path, span)),
    );

    const stretches = read.filter((stretch) => stretch !== "large");

    return stretches.length < read.length
      ? { kind: "large", citation }
      : { kind: "lines", citation, stretches };
  } catch (error: unknown) {
    return { kind: "failed", citation, message: failure(error) };
  }
}

const MARKER = "[data-cite]";

const MARKER_KEYS = ["data-cite"];

const panelFocused = (): boolean => panel.contains(document.activeElement);

function focusViewerClose(): void {
  const close = panel.querySelector(".viewer-close");

  if (close instanceof HTMLElement) {
    close.focus();
  }
}

// A later click or move drops the lines a slower answer brings. The close button takes the focus,
// and keeps it when the lines replace the wait, unless the reader moved it meanwhile.
async function openCitation(citation: Citation, marker: Element): Promise<void> {
  if (viewer === null) {
    panelTop = panel.scrollTop;
  }

  openedFrom = markOf(cardsView.contains(marker) ? cardsView : panel, MARKER_KEYS, marker);
  const opened: Viewer = { kind: "loading", citation };
  viewer = opened;
  render();
  focusViewerClose();
  const read = await linesOf(citation);

  if (viewer === opened) {
    const focused = panelFocused();
    viewer = read;
    render();

    if (focused) {
      focusViewerClose();
    }
  }
}

// The marker the lines opened from takes the focus back, when the viewer held it.
function closeCitation(): void {
  const focused = panelFocused();
  viewer = null;
  render();
  panel.scrollTop = panelTop;

  if (focused && openedFrom !== null) {
    refocus(openedFrom);
  }
}

// The citation of the marker a click lands on, in the panel or the cards.
function citedAt(target: Element): Citation | null {
  const cited = target.closest("[data-cite]");

  return cited instanceof HTMLElement ? citationOf(cited.dataset["cite"] ?? "") : null;
}

panel.addEventListener("click", (e) => {
  if (!(e.target instanceof Element)) {
    return;
  }

  const cited = e.target.closest(MARKER);
  const citation = citedAt(e.target);
  const step = e.target.closest("[data-step]");

  if (cited !== null && citation !== null) {
    void openCitation(citation, cited);
  } else if (e.target.closest("[data-close-viewer]") !== null) {
    closeCitation();
  } else if (step instanceof HTMLElement) {
    keepingPanelFocus(NAV_KEYS, () => {
      play(pageState.journey, Number(step.dataset["step"]));
    });
  } else if (e.target.closest("[data-leave]") !== null) {
    keepingPanelFocus(LEAVE_KEYS, leave);
  }
});

// A column's header selects its leaf, as a click on its card does; a marker in a cell shows its
// lines in the panel, as one in the panel does, showing the panel if it was hidden; a click
// elsewhere on the cards does nothing.
cardsView.addEventListener("click", (e) => {
  if (!(e.target instanceof Element)) {
    return;
  }

  const header = e.target.closest("[data-select]");
  const cited = e.target.closest(MARKER);
  const citation = citedAt(e.target);

  if (header instanceof HTMLElement) {
    send({ type: "select", id: header.dataset["select"] ?? "" });
  } else if (cited !== null && citation !== null) {
    if (panel.hidden) {
      showPanel(true);
    }

    void openCitation(citation, cited);
  }
});

function showMode(mode: Mode): void {
  params = { ...params, mode };
  rerender();
}

mapButton.addEventListener("click", () => {
  showMode("map");
});

cardsButton.addEventListener("click", () => {
  showMode("cards");
});

function showPhase(phase: string | null): void {
  params = { ...params, phase };
  rerender();
}

for (const [phase, button] of steps) {
  button.addEventListener("click", () => {
    showPhase(phase);
  });
}

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

    keepingPanelFocus(NAV_KEYS, () => {
      send(id === "" ? { type: "home" } : { type: "jump", id });
    });
  }
});

byId("btn-home", HTMLButtonElement).addEventListener("click", () => {
  send({ type: "home" });
});

// A reader's choice, remembered per browser. Blocked storage throws on each access: the choice
// then starts as its default and lasts for the visit.
function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Blocked storage: the choice lasts for this visit only.
  }
}

// A button that shows or hides an element, remembered per browser; the element starts shown.
// Answers the way to show or hide it as the button does.
function bindToggle(
  button: HTMLButtonElement,
  target: HTMLElement,
  key: string,
): (visible: boolean) => void {
  const show = (visible: boolean): void => {
    target.hidden = !visible;
    button.setAttribute("aria-pressed", String(visible));
  };

  const toggle = (visible: boolean): void => {
    show(visible);
    store(key, visible ? "shown" : "hidden");
  };

  show(stored(key) !== "hidden");

  button.addEventListener("click", () => {
    toggle(target.hidden !== false);
  });

  return toggle;
}

bindToggle(legendButton, legend, "atlas.legend");

const showPanel = bindToggle(byId("btn-panel", HTMLButtonElement), panel, "atlas.panel");

// The citations show as markers until the reader asks for them in full, remembered per browser.
const SOURCES_KEY = "atlas.sources";

function showSources(full: boolean): void {
  sourcesInFull = full;
  panel.classList.toggle("full-sources", full);
  cardsView.classList.toggle("full-sources", full);
  sourcesButton.setAttribute("aria-pressed", String(full));
}

showSources(stored(SOURCES_KEY) === "full");

sourcesButton.addEventListener("click", () => {
  showSources(!sourcesInFull);
  store(SOURCES_KEY, sourcesInFull ? "full" : "markers");
});

// The camera's mode on a journey, remembered per browser; any other value stored reads as
// "section". A mode picked frames the step's view anew at once, in one move, and leaves the
// playback playing.
const CAMERA_KEY = "atlas.camera";

let cameraMode: CameraMode = CAMERA_MODES.find((mode) => mode === stored(CAMERA_KEY)) ?? "section";

function markCamera(): void {
  for (const [mode, button] of cameraButtons) {
    button.setAttribute("aria-pressed", String(mode === cameraMode));
  }
}

markCamera();

function showCamera(mode: CameraMode): void {
  cameraMode = mode;
  store(CAMERA_KEY, mode);
  markCamera();
  const key = openOf(here());

  if (cam !== null && heldOf(st, key) !== null) {
    moveTo(key, shown(cam, performance.now()).space);
  }
}

for (const [mode, button] of cameraButtons) {
  button.addEventListener("click", () => {
    showCamera(mode);
  });
}

// Escape and a click on the empty sheet: the fit back first, but over the cards, whose drawing's
// zoom is not theirs to undo; then the lines viewer closes where the reader stands; then, on a
// journey, back to the place it started from; else deselect, then up a level.
function backOut(): void {
  if (cardsShown === undefined && unzoom()) {
    return;
  }

  if (viewer !== null) {
    closeCitation();

    return;
  }

  if (pageState.journey !== null) {
    leave();

    return;
  }

  const at = here();

  if (at !== navigate(tree, at, { type: "escape" })) {
    send({ type: "escape" });
  }
}

// On a journey, the arrow keys press the panel's ← → buttons, and Space the ribbon's play button,
// but where the focus is on what Space presses itself.
const ARROWS = new Map([
  ["ArrowLeft", -1],
  ["ArrowRight", 1],
]);

const SPACE_PRESSES = "input, textarea, button, .hit";

document.addEventListener("keydown", (e) => {
  const typing = e.target instanceof HTMLInputElement;
  const listing = openList.matches(":popover-open") || journeyList.matches(":popover-open");
  const delta = ARROWS.get(e.key);
  const modified = e.altKey || e.ctrlKey || e.metaKey || e.shiftKey;
  const pressing = e.target instanceof Element && e.target.closest(SPACE_PRESSES) !== null;

  if (typing || listing) {
    return;
  }

  if (e.key === "Escape") {
    backOut();
  } else if (delta !== undefined && !modified && pageState.journey !== null) {
    e.preventDefault();
    keepingPanelFocus(NAV_KEYS, () => {
      stepBy(delta);
    });
  } else if (e.key === " " && !modified && !pressing && pageState.journey !== null) {
    e.preventDefault();

    if (!e.repeat) {
      togglePlayback();
    }
  }
});

// render() writes the fragment with replaceState, which fires no hashchange: this is a fragment
// typed into the address bar. It stops a journey's playback.
addEventListener("hashchange", () => {
  stopPlayback();
  place = placeOfHash(tree, location.hash);
  params = paramsOfHash(scope, location.hash);
  viewer = null;
  render();
  settle().catch(fail);
});

// A label shown takes no pointer events, so a click on it reaches the sheet: it is found by where
// it lies. A journey's trace takes none either, but for its numbers and its pills.
function onArrow(e: MouseEvent): boolean {
  if (e.target instanceof Element && e.target.closest(".flow, .flow-hit, .trace-mark") !== null) {
    return true;
  }

  const labels = heldOf(st, openOf(here()))?.arrows.flatMap(({ label }) => label ?? []) ?? [];

  return labels.some((label) => {
    const r = label.getBoundingClientRect();

    return (
      !label.classList.contains("illegible") &&
      e.clientX >= r.left &&
      e.clientX <= r.right &&
      e.clientY >= r.top &&
      e.clientY <= r.bottom
    );
  });
}

// On a journey, a click on an arrow, its band or its label, or on a number or a pill of the
// trace, is no click on the empty sheet: it leaves nothing.
svg.addEventListener("click", (e) => {
  if (pageState.journey === null || !onArrow(e)) {
    backOut();
  }
});

// Every view is laid out again when the aspect of the drawing area moves by more than RELAYOUT
// (a resized window, the panel hidden or shown), once the resizing settles, with the Config's
// overview ratio "screen"; and when the fonts settle late. A move under way ends where it was
// going.
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

  relayout(() => true);
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
  '500 12px "IBM Plex Mono"',
  '400 12px "IBM Plex Sans"',
];

// A journey's texts, the ribbon's numbers and words, the camera's, the trace's pills, and the
// boxes' index.
const journeyText = (): string[] =>
  journeys.flatMap((journey) => [
    RANGE_DASH,
    RANGE_JOINT,
    words.play,
    words.pause,
    words.cameraLabel,
    ...Object.values(words.camera),
    ...journey.sections.map((section) => section.label),
    ...stepsOf(journey).flatMap(({ n, step }) => [
      String(n),
      isEntry(step) ? entryText(step) : "",
      step.carries ?? "",
      step.when === undefined ? "" : words.when(step.when),
      step.note ?? "",
    ]),
  ]);

const shownText = (): string =>
  [
    ...new Set(
      [
        ...[...tree.nodes.values()].flatMap((n) => [n.label, n.label.toUpperCase(), n.sub]),
        ...tree.map.links.map((l) => l.label),
        ...journeyText(),
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
  params = paramsOfHash(scope, location.hash);
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
