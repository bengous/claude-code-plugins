/* oxlint-disable anti-slop/no-unknown-parameters -- the values typed `unknown` here are what a `catch` or a rejected promise hands over, and the JSON of threads.json, which readThreads parses: there is no earlier place to narrow them. */
// The page's entry (atlas.html loads it; serve.ts bundles it). It draws the
// map it is given, atlas:map and atlas:config, which serve.ts resolves to the
// files of a map folder; it holds no content: a new brick, arrow or text
// belongs in the map's data.
//
// Two levels share one SVG:
//   overview  where the page opens (overview.ts). Every zone is a box listing
//             its bricks by name, nested as the zones nest; the services
//             outside the server stand in a column on each side; one arrow
//             per pair of boxes. Readable at its own scale.
//   detail    every brick with its subtitle, every arrow with its label
//             (detail.ts).
// The detail is drawn far to the right of the overview (x = overview width +
// 4000), so the two never overlap. Clicks drive two state machines
// (machine.ts): navigation decides where the reader stands, and the camera
// moves there in one step, cross-fading the levels on the way. There is no
// free zoom or drag.
//
// Nothing in the data has a position or a size, and nothing should get one:
// ELK (layout.ts, overview.ts) sizes and places the boxes, libavoid
// (avoid.ts) routes the overview's arrows. Text is measured from the rendered
// fonts (measure.ts), so layout waits for them (start).
import config from "atlas:config";
import map from "atlas:map";

import { toPlan } from "./adapter.ts";
import type { Detail } from "./detail.ts";
import { drawDetail } from "./detail.ts";
import { got, graphOf } from "./graph.ts";
import { legendHtml, legendKeys } from "./legend.ts";
import type { Anchor, Camera, Image, NavEvent, Place, Rect, Target } from "./machine.ts";
import { alignment, anchorOf, camera, navigate, shown } from "./machine.ts";
import { fontKey } from "./measure.ts";
import type { Overview, Packing } from "./overview.ts";
import { drawOverview } from "./overview.ts";
import type { ThreadState } from "./panel.ts";
import { coupledWith, renderCrumbs, renderOpenList, renderPanel } from "./panel.ts";
import type { PaletteRule } from "./settings.ts";
import { paletteRules, settingsOf } from "./settings.ts";
import { defs, el, esc } from "./svg.ts";
import { TOKEN_HEADER, TOKEN_META, readThreads } from "./threads.ts";
import type { Selected } from "./wire.ts";
import { SELECTION_PATH } from "./wire.ts";

const settings = settingsOf(config);

const words = settings.words;

const graph = graphOf(toPlan(map, config));

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
  for (const [key, swatch] of Object.entries(settings.palette)) {
    for (const shade of ["light", "dark"] as const) {
      if (!CSS.supports("color", swatch[shade])) {
        throw new Error(
          `palette ${key}.${shade}: "${swatch[shade]}" is not a colour this browser draws`,
        );
      }
    }
  }

  const element = document.createElement("style");
  document.head.append(element);
  const { sheet } = element;

  if (sheet === null) {
    throw new TypeError("palette: a <style> in the document has no sheet");
  }

  for (const rule of paletteRules(settings.palette)) {
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
  legend.innerHTML = legendHtml(legendKeys(graph), settings.legend);
}

dressPage();

// serve.ts answers it from the map folder, and takes a reply posted to it.
const THREADS_URL = "threads.json";

const token = document.querySelector(`meta[name="${TOKEN_META}"]`)?.getAttribute("content") ?? "";

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

const DUR = 700;

type Drawing = {
  readonly ov: Overview;
  readonly dt: Detail;
  readonly ovLayer: SVGGElement;
  readonly dtLayer: SVGGElement;
  readonly anchors: ReadonlyMap<string, Anchor>;
};

let drawing: Drawing | null = null;

let place: Place = { zone: null, node: null };

let cam: Camera | null = null;

let raf = 0;

let builtFonts = "";

let builtAspect = 1;

let threads: ThreadState = { kind: "ok", threads: {} };

function drawn(): Drawing {
  if (drawing === null) {
    throw new Error("the plan is not drawn yet");
  }

  return drawing;
}

// The camera is the SVG viewBox, always at the aspect of the element, so
// nothing is letterboxed. paint() draws the image the camera machine returns,
// frame by frame.
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

function imageOf(p: Place): Target {
  const d = drawn();

  if (p.zone === null) {
    const all = { x: 0, y: 0, w: d.ov.size.w, h: d.ov.size.h };

    return { space: "ov", vb: fit(all, 10), op: { ov: 1, dt: 0 } };
  }

  return { space: "dt", vb: fit(anchorOf(d.anchors, p.zone).dt, 16), op: { ov: 0, dt: 1 } };
}

// A drawing that does not show is hidden, so it takes no click and costs no
// paint. While both show, the one in the other space carries the alignment.
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

function paint(img: Image): void {
  const d = drawn();
  svg.setAttribute("viewBox", `${img.vb.x} ${img.vb.y} ${img.vb.w} ${img.vb.h}`);
  const a = img.align === null ? null : alignment(anchorOf(d.anchors, img.align));
  const ovMoved = a !== null && img.space === "dt";
  const dtMoved = a !== null && img.space === "ov";

  const ovTransform = ovMoved
    ? `translate(${a.dc.join(",")}) scale(${a.k}) translate(${-a.oc[0]},${-a.oc[1]})`
    : "";

  const dtTransform = dtMoved
    ? `translate(${a.oc.join(",")}) scale(${1 / a.k}) translate(${-a.dc[0]},${-a.dc[1]})`
    : "";

  paintLayer(d.ovLayer, img.op.ov, ovTransform);
  paintLayer(d.dtLayer, img.op.dt, dtTransform);
}

function frame(): void {
  if (cam === null) {
    return;
  }

  const now = performance.now();
  cam = camera(cam, { type: "tick", now }, drawn().anchors);
  paint(shown(cam, now));
  raf = cam.kind === "moving" ? requestAnimationFrame(frame) : 0;
}

// link: the zone entered, or for a return to the overview the zone left.
function moveTo(p: Place, link: string | null): void {
  if (cam === null) {
    return;
  }

  const ev = {
    type: "go",
    to: imageOf(p),
    link,
    now: performance.now(),
    dur: reduced ? 0 : DUR,
  } as const;

  cam = camera(cam, ev, drawn().anchors);

  if (raf === 0) {
    raf = requestAnimationFrame(frame);
  }
}

function jumpTo(p: Place): void {
  const image: Image = { ...imageOf(p), align: null };
  cam =
    cam === null ? { kind: "idle", image } : camera(cam, { type: "jump", image }, drawn().anchors);
  paint(image);
}

// render() rebuilds the panel and the breadcrumb, then toggles classes on both
// levels: focused zone, selected brick, coupled bricks, hot arrows.
function highlight(p: Place): void {
  const d = drawn();
  const coupled = p.node === null ? [] : coupledWith(graph, p.node);

  for (const [id, gs] of d.dt.zoneEls) {
    for (const g of gs) {
      g.classList.toggle("focused", id === p.zone);
    }
  }

  for (const registry of [d.dt.nodeEls, d.ov.nodeEls]) {
    for (const [id, gs] of registry) {
      for (const g of gs) {
        g.classList.toggle("selected", id === p.node);
        g.classList.toggle("coupled", coupled.includes(id));
      }
    }
  }

  for (const e of [...d.dt.arrows, ...d.ov.arrows]) {
    const hot = p.node !== null && e.bricks.includes(p.node);
    e.g.classList.toggle("hot", hot);
    const m = hot ? "url(#arr-hot)" : e.marker;
    e.path.setAttribute("marker-end", m);

    if (e.two) {
      e.path.setAttribute("marker-start", m);
    }
  }

  d.ovLayer.classList.toggle("selecting", p.node !== null);
}

// Overview arrows rest faded; hovering a chip, a pill or a module's frame
// lights the arrows that touch it and fades the others further. The labels of
// a lit arrow stay readable. Nesting frames carry no data-zone: they cover
// most of the sheet, so hovering them would fade nearly every arrow.
function hoverOverview(target: EventTarget | null): void {
  if (drawing === null) {
    return;
  }

  const over = target instanceof Element ? target.closest("[data-brick], [data-zone]") : null;
  // oxlint-disable-next-line unicorn/prefer-dom-node-dataset -- closest() answers an `Element`, which has no `dataset`: only its HTML and SVG kinds do.
  const brick = over?.getAttribute("data-brick") ?? null;
  // oxlint-disable-next-line unicorn/prefer-dom-node-dataset -- the same `Element` as the line above.
  const zid = over?.getAttribute("data-zone") ?? null;
  const box = zid === null ? null : graph.zoneBox(zid);

  for (const a of drawing.ov.arrows) {
    const lit =
      (brick !== null && a.bricks.includes(brick)) ||
      (box !== null && (a.from === box || a.to === box));

    a.g.classList.toggle("lit", lit);
  }

  drawing.ovLayer.classList.toggle("focusing", brick !== null || box !== null);
}

svg.addEventListener("pointerover", (e) => {
  hoverOverview(e.target);
});

svg.addEventListener("pointerleave", () => {
  hoverOverview(null);
});

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

function render(): void {
  renderPanel(settings, graph, panel, place, drawn().ov.avoidError, threads);
  renderOpenList(settings, graph, openButton, openList, threads);
  renderCrumbs(settings, graph, crumbs, place);
  highlight(place);
  // Keeps #id in the URL so a link reopens the same view.
  const id = place.node ?? place.zone;
  history.replaceState(null, "", id === null ? location.pathname + location.search : `#${id}`);
  tellSelection(id);
}

// Every input becomes a navigation event: the place changes, the camera heads
// to it, the panel follows.
function send(ev: NavEvent): void {
  const left = place.zone;
  place = navigate(place, ev, graph.zoneOfNode);
  moveTo(place, place.zone ?? left);
  render();
}

// threads.json is read at start and each time the window regains focus (an
// agent replies from the terminal); a reply from the page is POSTed to
// serve.ts with the token it wrote into the page, and it answers the updated
// threads.
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

// Re-renders with new threads, keeping the panel where the reader is.
function showThreads(next: ThreadState): void {
  const top = panel.scrollTop;
  threads = next;
  render();
  panel.scrollTop = top;
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
    if (drawing !== null && JSON.stringify(next) !== JSON.stringify(threads)) {
      showThreads(next);
    }
  });
});

// Clicks and keys only: the camera follows navigation and nothing else.
function go(id: string): void {
  if (id === "") {
    send({ type: "home" });
  } else if (graph.isZone(id)) {
    send({ type: "zone", id });
  } else {
    send({ type: "node", id });
  }
}

document.addEventListener("click", (e) => {
  const b = e.target instanceof Element ? e.target.closest("[data-go]") : null;

  if (
    b instanceof HTMLElement &&
    (panel.contains(b) || crumbs.contains(b) || openList.contains(b))
  ) {
    openList.hidePopover();
    go(b.dataset["go"] ?? "");
  }
});

byId("btn-home", HTMLButtonElement).addEventListener("click", () => {
  send({ type: "home" });
});

// A button that shows or hides an element, remembered per browser. When
// storage is blocked, the element starts shown and the button still works
// for the visit.
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

if (legend.childElementCount === 0) {
  legend.remove();
  legendButton.remove();
} else {
  bindToggle(legendButton, legend, "atlas.legend");
}

bindToggle(byId("btn-panel", HTMLButtonElement), panel, "atlas.panel");

document.addEventListener("keydown", (e) => {
  const typing = e.target instanceof HTMLInputElement;

  if (
    e.key === "Escape" &&
    !typing &&
    !openList.matches(":popover-open") &&
    (place.zone !== null || place.node !== null)
  ) {
    send({ type: "back" });
  }
});

// A click on the empty sheet goes back to the overview.
svg.addEventListener("click", () => {
  if (place.zone !== null || place.node !== null) {
    send({ type: "home" });
  }
});

// With the Config's overview ratio "screen", the overview is packed for the
// aspect of the drawing area: when that aspect moves by more than RELAYOUT (a
// resized window, the panel hidden or shown), the plan is laid out again once
// the resizing settles.
const RELAYOUT = { change: 0.15, settleMs: 300 };

let relayoutTimer: ReturnType<typeof setTimeout> | undefined;

function relayoutIfNeeded(): void {
  if (
    drawing === null ||
    settings.ratio !== "screen" ||
    Math.abs(aspect() - builtAspect) / builtAspect < RELAYOUT.change
  ) {
    return;
  }

  build().then(
    (d) => {
      drawing = d;
      jumpTo(place);
      render();
    },
    (error: unknown) => {
      fail(error);
    },
  );
}

new ResizeObserver(() => {
  if (cam !== null) {
    jumpTo(place);
  }

  clearTimeout(relayoutTimer);
  relayoutTimer = setTimeout(relayoutIfNeeded, RELAYOUT.settleMs);
}).observe(svg);

// Fonts: the measure must use the faces the page renders with, so layout
// waits for them. document.fonts.ready alone is not enough: it only waits for
// faces already requested, and Google Fonts splits each weight into
// unicode-range subsets, fetched on first use. So each face is loaded with
// the text the plan shows. A face that still arrives late (slow network)
// changes the measured widths: everything is then laid out again.
const FACES = [
  '600 16px "Barlow Condensed"',
  '700 16px "Barlow Condensed"',
  '400 12px "IBM Plex Mono"',
];

const shownText = (): string =>
  [
    ...new Set(
      [
        ...graph.plan.nodes.flatMap((n) => [n.label, n.sub]),
        ...graph.plan.zones.flatMap((z) => [z.title.toUpperCase(), z.tag]),
        ...graph.plan.edges.map((e) => e.label),
      ].join(""),
    ),
  ].join("");

// Lays out and draws both levels from scratch: the overview at x 0, the
// detail to its right.
async function build(): Promise<Drawing> {
  svg.replaceChildren();
  defs(svg);
  builtFonts = fontKey();
  builtAspect = aspect();
  const grid = el("rect", { fill: "url(#grid)" }, svg);
  const ovLayer = el("g", { class: "layer-ov" }, svg);

  const packing: Packing =
    settings.ratio === "screen"
      ? { kind: "screen", aspect: builtAspect }
      : { kind: "fixed", ratio: settings.ratio };

  const ov = await drawOverview(graph, words, ovLayer, send, packing, settings.pins);
  const dtX = ov.size.w + 4000;
  const dtLayer = el("g", { class: "layer-dt" }, svg);
  const dt = await drawDetail(graph, words, dtLayer, dtX, send);
  grid.setAttribute("x", String(-ov.size.w));
  grid.setAttribute("y", String(-ov.size.h * 2));
  grid.setAttribute("width", String(dtX + dt.size.w + ov.size.w * 2));
  grid.setAttribute("height", String(Math.max(ov.size.h, dt.size.h) * 5));

  // What the camera frames for each zone: the zone, or for a zone that holds
  // sub-zones its own bricks. Framed whole, such a zone's
  // detail is too small to read, and each sub-zone is one click away.
  const anchors = new Map(
    graph.plan.zones.map((z): [string, Anchor] => {
      const key = graph.zoneBox(z.id);

      return [
        z.id,
        { ov: got(ov.rects, key, "overview rect"), dt: got(dt.rects, key, "detail rect") },
      ];
    }),
  );

  return { ov, dt, ovLayer, dtLayer, anchors };
}

async function start(): Promise<void> {
  applyPalette();
  const text = shownText();
  await Promise.all(FACES.map((f) => document.fonts.load(f, text)));
  await document.fonts.ready;
  [drawing, threads] = await Promise.all([build(), loadThreads()]);
  // A bare #id opens the page on that zone or brick, without a move.
  const id = location.hash.slice(1);

  if (graph.isZone(id)) {
    place = navigate(place, { type: "zone", id }, graph.zoneOfNode);
  } else if (graph.isNode(id)) {
    place = navigate(place, { type: "node", id }, graph.zoneOfNode);
  }

  jumpTo(place);
  render();
  document.fonts.addEventListener("loadingdone", () => {
    if (fontKey() === builtFonts) {
      return;
    }

    build().then(
      (d) => {
        drawing = d;
        jumpTo(place);
        render();
      },
      (error: unknown) => {
        fail(error);
      },
    );
  });
}

function fail(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  panel.innerHTML = `<p class="warn">${words.drawFailed(esc(message))}</p>`;
  console.error(err);
}

// oxlint-disable-next-line unicorn/prefer-top-level-await -- an await here would hold the entry module's evaluation until the fonts load and the layout ends; the page starts as a chain, and fail() shows what broke.
start().catch(fail);
