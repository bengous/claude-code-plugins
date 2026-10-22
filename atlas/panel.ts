import type { OpenPoint, Pair } from "./atlas.ts";
import type { Graph } from "./graph.ts";
import type { Place } from "./machine.ts";
import type { Info } from "./model.ts";
import type { Settings } from "./settings.ts";
import { esc } from "./svg.ts";
import type { Entry, Threads, Who } from "./threads.ts";
import { firstLine, openItems, waitsFor } from "./threads.ts";

// The panel shows the `info` fields in the order of Panel in atlas.ts; HTML
// in them is trusted (it comes from the map's data), ids and labels are
// escaped.
//
// threads.json as the page last read it, or why it could not.
export type ThreadState =
  | { readonly kind: "ok"; readonly threads: Threads }
  | { readonly kind: "error"; readonly message: string };

const threadOf = (state: ThreadState, id: string): readonly Entry[] =>
  state.kind === "ok" ? (state.threads[id] ?? []) : [];

const nameOf = (s: Settings, who: Who): string => (who === "human" ? (s.human ?? who) : who);

const waits = (s: Settings, who: Who | null): string =>
  s.words.waits(who === null ? null : esc(nameOf(s, who)));

function openPoint(s: Settings, o: OpenPoint, state: ThreadState): string {
  const thread = threadOf(state, o.id);

  const entries = thread
    .map((e) => `<li><span class="who">${esc(nameOf(s, e.who))}</span> ${esc(e.text)}</li>`)
    .join("");

  let log = entries === "" ? "" : `<ol class="thread">${entries}</ol>`;

  if (state.kind === "error") {
    log = `<p class="reply-error">${s.words.unreadable(esc(state.message))}</p>`;
  }

  return [
    `<div class="open-point">`,
    `<p class="open-id"><code>${esc(o.id)}</code> · ${waits(s, waitsFor(thread))}</p>`,
    `<p class="warn">${o.text}</p>`,
    log,
    `<form class="reply" data-open="${esc(o.id)}">`,
    `<input name="text" required autocomplete="off" placeholder="${s.words.replyPlaceholder(esc(nameOf(s, "human")))}" aria-label="${s.words.replyLabel(esc(o.id))}">`,
    `<button type="submit">${s.words.reply}</button>`,
    `</form></div>`,
  ].join("");
}

const openSection = (
  s: Settings,
  open: readonly OpenPoint[] | undefined,
  state: ThreadState,
): string =>
  open === undefined || open.length === 0
    ? ""
    : `<h3>${s.words.openPoints}</h3>${open.map((o) => openPoint(s, o, state)).join("")}`;

function chip(graph: Graph, id: string): string {
  let item: { readonly color: string; readonly label: string } | null = null;

  if (graph.isNode(id)) {
    item = { color: graph.node(id).color, label: graph.node(id).label };
  } else if (graph.isZone(id)) {
    item = { color: graph.zone(id).color, label: graph.zone(id).title };
  }

  if (item === null) {
    return "";
  }

  const label = esc(item.label.replaceAll("\n", " "));

  return `<button type="button" class="chip" data-go="${esc(id)}" style="--zc: var(${item.color})"><span class="dot"></span>${label}</button>`;
}

const pointList = (graph: Graph, items: readonly Pair[]): string =>
  `<ul class="points">${items.map(([id, t]) => `<li>${t} ${chip(graph, id)}</li>`).join("")}</ul>`;

const pairs = (items: readonly Pair[], escape: boolean): string =>
  items.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${escape ? esc(v) : v}</dd>`).join("");

const list = (items: readonly string[], escape: boolean): string =>
  items.map((i) => `<li>${escape ? esc(i) : i}</li>`).join("");

function replaceSection(s: Settings, graph: Graph, info: Info, coupled: readonly string[]): string {
  if (info.swap === undefined && coupled.length === 0) {
    return "";
  }

  const swap = info.swap === undefined ? "" : `<p>${info.swap}</p>`;

  const chips =
    coupled.length === 0
      ? ""
      : `<p class="label">${s.words.coupledWith}</p><div class="chips">${coupled.map((id) => chip(graph, id)).join("")}</div>`;

  return `<h3>${s.words.swap}</h3>${swap}${chips}`;
}

// The sections after the contract, in panel order: [heading, body] or "".
function laterSections(s: Settings, graph: Graph, info: Info, state: ThreadState): string {
  const w = s.words;

  return [
    info.extend === undefined ? "" : `<h3>${w.extend}</h3><p>${info.extend}</p>`,
    info.pitfalls === undefined || info.pitfalls.length === 0
      ? ""
      : `<h3>${w.pitfalls}</h3><ul>${list(info.pitfalls, false)}</ul>`,
    info.seams === undefined ? "" : `<h3>${w.seams}</h3>${pointList(graph, info.seams)}`,
    info.traps === undefined ? "" : `<h3>${w.traps}</h3>${pointList(graph, info.traps)}`,
    info.why === undefined || info.why.length === 0
      ? ""
      : `<h3>${w.why}</h3><ul>${list(info.why, false)}</ul>`,
    info.alt === undefined ? "" : `<h3>${w.alt}</h3><p class="alt">${info.alt}</p>`,
    info.facts === undefined
      ? ""
      : `<h3>${w.facts}</h3><dl class="facts">${pairs(info.facts, true)}</dl>`,
    openSection(s, info.open, state),
    info.how === undefined ? "" : `<h3>${w.how}</h3><p>${info.how}</p>`,
  ].join("");
}

function renderInfo(
  s: Settings,
  graph: Graph,
  info: Info,
  color: string,
  extra: string,
  coupled: readonly string[],
  brief: readonly string[],
  state: ThreadState,
): string {
  return [
    `<div style="--zc: var(${color})">`,
    info.kicker === undefined ? "" : `<p class="kicker">${esc(info.kicker)}</p>`,
    `<h2><span class="swatch"></span>${info.title}</h2>`,
    info.lead === undefined ? "" : `<p class="lead">${info.lead}</p>`,
    brief.length === 0 ? "" : `<ul class="brief">${list(brief, true)}</ul>`,
    info.io === undefined
      ? ""
      : `<h3>${s.words.io}</h3><dl class="facts io">${pairs(info.io, false)}</dl>`,
    replaceSection(s, graph, info, coupled),
    laterSections(s, graph, info, state),
    extra,
    info.see === undefined || info.see.length === 0
      ? ""
      : `<h3>${s.words.see}</h3><div class="chips">${info.see.map((id) => chip(graph, id)).join("")}</div>`,
    info.src === undefined ? "" : `<p class="src">${s.words.source(esc(info.src))}</p>`,
    "</div>",
  ].join("");
}

// Couplings are declared on either side; this makes them symmetric.
export function coupledWith(graph: Graph, id: string): string[] {
  const set = new Set(graph.node(id).couples);

  for (const n of graph.plan.nodes) {
    if (n.couples.includes(id)) {
      set.add(n.id);
    }
  }

  set.delete(id);

  return [...set].filter((n) => graph.isNode(n));
}

function zoneTour(graph: Graph, zid: string): string {
  const order = graph.plan.zoneOrder;
  const i = order.indexOf(zid);
  const prev = graph.zone(order[(i + order.length - 1) % order.length] ?? zid);
  const next = graph.zone(order[(i + 1) % order.length] ?? zid);

  return `<div class="nav"><button type="button" data-go="${esc(prev.id)}">← ${esc(prev.title)}</button><button type="button" data-go="${esc(next.id)}">${esc(next.title)} →</button></div>`;
}

function overviewExtra(s: Settings, graph: Graph, avoidError: string | null): string {
  const chips = graph.plan.zoneOrder.map((id) => chip(graph, id)).join("");
  const zones = `<h3>${s.words.zones}</h3><div class="chips">${chips}</div>`;

  if (avoidError === null) {
    return zones;
  }

  return `${zones}<h3>${s.words.arrowsMissing}</h3><p class="warn">${s.words.avoidFailed(esc(avoidError))}</p>`;
}

export function renderPanel(
  s: Settings,
  graph: Graph,
  panel: Pick<HTMLElement, "innerHTML" | "scrollTop">,
  place: Place,
  avoidError: string | null,
  state: ThreadState,
): void {
  if (place.node !== null) {
    const n = graph.node(place.node);

    const up =
      n.zone === null
        ? ""
        : `<div class="nav"><button type="button" data-go="${esc(n.zone)}">↑ ${esc(graph.zone(n.zone).title)}</button></div>`;

    panel.innerHTML =
      renderInfo(s, graph, n.info, n.color, "", coupledWith(graph, n.id), [], state) + up;
  } else if (place.zone === null) {
    panel.innerHTML = renderInfo(
      s,
      graph,
      graph.plan.overview,
      "--accent",
      overviewExtra(s, graph, avoidError),
      [],
      [],
      state,
    );
  } else {
    const z = graph.zone(place.zone);
    panel.innerHTML =
      renderInfo(s, graph, z.info, z.color, "", [], z.kw, state) + zoneTour(graph, z.id);
  }

  panel.scrollTop = 0;
}

// The header button and the list it opens: one row per open point, a click
// goes to its zone or brick.
export function renderOpenList(
  s: Settings,
  graph: Graph,
  button: HTMLButtonElement,
  menu: HTMLElement,
  state: ThreadState,
): void {
  const items = openItems(graph.plan);

  const count = (who: Who): number =>
    items.filter((i) => waitsFor(threadOf(state, i.id)) === who).length;

  button.textContent = s.words.openCount(items.length);

  const rows = items.map((i) =>
    [
      `<li><button type="button" class="open-row" data-go="${esc(i.owner)}">`,
      `<span><code>${esc(i.id)}</code> <span class="open-owner">${s.words.owner[i.kind]} ${esc(i.ownerLabel)}</span></span>`,
      `<span class="open-wait">${waits(s, waitsFor(threadOf(state, i.id)))}</span>`,
      `<span class="open-line">${esc(firstLine(i.text))}</span>`,
      `</button></li>`,
    ].join(""),
  );

  const humanName = s.human === null ? null : esc(s.human);

  const sum =
    state.kind === "error"
      ? `<p class="reply-error">${s.words.unreadable(esc(state.message))}</p>`
      : `<p class="open-sum">${s.words.openSum(count("human"), count("agent"), humanName)}</p>`;

  menu.innerHTML = `<h2>${s.words.openPoints}</h2>${sum}<ul>${rows.join("")}</ul>`;
}

export function renderCrumbs(s: Settings, graph: Graph, crumbs: HTMLElement, place: Place): void {
  const current = 'aria-current="true"';

  const parts = [
    `<button type="button" data-go="" ${place.zone === null && place.node === null ? current : ""}>${esc(s.title)}</button>`,
  ];

  if (place.zone !== null) {
    const title = esc(graph.zone(place.zone).title);
    parts.push(
      `<span class="sep">›</span><button type="button" data-go="${esc(place.zone)}" ${place.node === null ? current : ""}>${title}</button>`,
    );
  }

  if (place.node !== null) {
    parts.push(
      `<span class="sep">›</span><button type="button" ${current}>${esc(graph.node(place.node).label)}</button>`,
    );
  }

  crumbs.innerHTML = parts.join("");
}
