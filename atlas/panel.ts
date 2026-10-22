import type { OpenPoint, Pair } from "./atlas.ts";
import { isNode, isZone, node, zone } from "./graph.ts";
import type { Place } from "./machine.ts";
import type { Info } from "./model.ts";
import { PLAN } from "./plan.ts";
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

const waits = (who: Who | null): string => `attend : ${who ?? "personne"}`;

function openPoint(o: OpenPoint, state: ThreadState): string {
  const thread = threadOf(state, o.id);

  const entries = thread
    .map((e) => `<li><span class="who">${e.who}</span> ${esc(e.text)}</li>`)
    .join("");

  let log = entries === "" ? "" : `<ol class="thread">${entries}</ol>`;

  if (state.kind === "error") {
    log = `<p class="reply-error">Fils illisibles : ${esc(state.message)}</p>`;
  }

  return [
    `<div class="open-point">`,
    `<p class="open-id"><code>${o.id}</code> · ${waits(waitsFor(thread))}</p>`,
    `<p class="warn">${o.text}</p>`,
    log,
    `<form class="reply" data-open="${o.id}">`,
    `<input name="text" required autocomplete="off" placeholder="Répondre (human)" aria-label="Répondre à ${o.id}">`,
    `<button type="submit">Répondre</button>`,
    `</form></div>`,
  ].join("");
}

const openSection = (open: readonly OpenPoint[] | undefined, state: ThreadState): string =>
  open === undefined || open.length === 0
    ? ""
    : `<h3>Points ouverts</h3>${open.map((o) => openPoint(o, state)).join("")}`;

function chip(id: string): string {
  let item: { readonly color: string; readonly label: string } | null = null;

  if (isNode(id)) {
    item = { color: node(id).color, label: node(id).label };
  } else if (isZone(id)) {
    item = { color: zone(id).color, label: zone(id).title };
  }

  if (item === null) {
    return "";
  }

  const label = esc(item.label.replaceAll("\n", " "));

  return `<button type="button" class="chip" data-go="${id}" style="--zc: var(${item.color})"><span class="dot"></span>${label}</button>`;
}

const pointList = (items: readonly Pair[]): string =>
  `<ul class="points">${items.map(([id, t]) => `<li>${t} ${chip(id)}</li>`).join("")}</ul>`;

const pairs = (items: readonly Pair[], escape: boolean): string =>
  items.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${escape ? esc(v) : v}</dd>`).join("");

const list = (items: readonly string[], escape: boolean): string =>
  items.map((i) => `<li>${escape ? esc(i) : i}</li>`).join("");

function replaceSection(info: Info, coupled: readonly string[]): string {
  if (info.swap === undefined && coupled.length === 0) {
    return "";
  }

  const swap = info.swap === undefined ? "" : `<p>${info.swap}</p>`;

  const chips =
    coupled.length === 0
      ? ""
      : `<p class="label">Change avec, entouré sur le plan :</p><div class="chips">${coupled.map((id) => chip(id)).join("")}</div>`;

  return `<h3>Pour remplacer</h3>${swap}${chips}`;
}

// The sections after the contract, in panel order: [heading, body] or "".
function laterSections(info: Info, state: ThreadState): string {
  return [
    info.extend === undefined ? "" : `<h3>Pour étendre</h3><p>${info.extend}</p>`,
    info.pitfalls === undefined || info.pitfalls.length === 0
      ? ""
      : `<h3>Pièges</h3><ul>${list(info.pitfalls, false)}</ul>`,
    info.seams === undefined ? "" : `<h3>Points d'extension</h3>${pointList(info.seams)}`,
    info.traps === undefined ? "" : `<h3>Couplages à connaître</h3>${pointList(info.traps)}`,
    info.why === undefined || info.why.length === 0
      ? ""
      : `<h3>Pourquoi</h3><ul>${list(info.why, false)}</ul>`,
    info.alt === undefined ? "" : `<h3>Écarté ou reporté</h3><p class="alt">${info.alt}</p>`,
    info.facts === undefined
      ? ""
      : `<h3>Repères</h3><dl class="facts">${pairs(info.facts, true)}</dl>`,
    openSection(info.open, state),
    info.how === undefined ? "" : `<h3>Lecture</h3><p>${info.how}</p>`,
  ].join("");
}

function renderInfo(
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
      : `<h3>Contrat</h3><dl class="facts io">${pairs(info.io, false)}</dl>`,
    replaceSection(info, coupled),
    laterSections(info, state),
    extra,
    info.see === undefined || info.see.length === 0
      ? ""
      : `<h3>Voir aussi</h3><div class="chips">${info.see.map(chip).join("")}</div>`,
    info.src === undefined ? "" : `<p class="src">Source : ${esc(info.src)}</p>`,
    "</div>",
  ].join("");
}

// Couplings are declared on either side; this makes them symmetric.
export function coupledWith(id: string): string[] {
  const set = new Set(node(id).couples);

  for (const n of PLAN.nodes) {
    if (n.couples.includes(id)) {
      set.add(n.id);
    }
  }

  set.delete(id);

  return [...set].filter((n) => isNode(n));
}

function zoneTour(zid: string): string {
  const order = PLAN.zoneOrder;
  const i = order.indexOf(zid);
  const prev = zone(order[(i + order.length - 1) % order.length] ?? zid);
  const next = zone(order[(i + 1) % order.length] ?? zid);

  return `<div class="nav"><button type="button" data-go="${prev.id}">← ${esc(prev.title)}</button><button type="button" data-go="${next.id}">${esc(next.title)} →</button></div>`;
}

function overviewExtra(avoidError: string | null): string {
  const zones = `<h3>Zones</h3><div class="chips">${PLAN.zoneOrder.map(chip).join("")}</div>`;

  if (avoidError === null) {
    return zones;
  }

  return `${zones}<h3>Flèches absentes</h3><p class="warn">libavoid ne s'est pas chargé : la vue d'ensemble n'a pas ses flèches. Le plan doit être servi par <code>bun atlas/serve.ts</code>, qui sert aussi <code>libavoid.wasm</code>. Erreur : <code>${esc(avoidError)}</code></p>`;
}

export function renderPanel(
  panel: HTMLElement,
  place: Place,
  avoidError: string | null,
  state: ThreadState,
): void {
  if (place.node !== null) {
    const n = node(place.node);

    const up =
      n.zone === null
        ? ""
        : `<div class="nav"><button type="button" data-go="${n.zone}">↑ ${esc(zone(n.zone).title)}</button></div>`;

    panel.innerHTML = renderInfo(n.info, n.color, "", coupledWith(n.id), [], state) + up;
  } else if (place.zone === null) {
    panel.innerHTML = renderInfo(
      PLAN.overview,
      "--accent",
      overviewExtra(avoidError),
      [],
      [],
      state,
    );
  } else {
    const z = zone(place.zone);
    panel.innerHTML = renderInfo(z.info, z.color, "", [], z.kw, state) + zoneTour(z.id);
  }

  panel.scrollTop = 0;
}

// The header button and the list it opens: one row per open point, a click
// goes to its zone or brick.
export function renderOpenList(
  button: HTMLButtonElement,
  menu: HTMLElement,
  state: ThreadState,
): void {
  const items = openItems(PLAN);

  const count = (who: Who): number =>
    items.filter((i) => waitsFor(threadOf(state, i.id)) === who).length;

  button.textContent = `Points ouverts : ${items.length}`;

  const rows = items.map((i) =>
    [
      `<li><button type="button" class="open-row" data-go="${i.owner}">`,
      `<span><code>${i.id}</code> <span class="open-owner">${i.kind === "zone" ? "zone" : "brique"} ${esc(i.ownerLabel)}</span></span>`,
      `<span class="open-wait">${waits(waitsFor(threadOf(state, i.id)))}</span>`,
      `<span class="open-line">${esc(firstLine(i.text))}</span>`,
      `</button></li>`,
    ].join(""),
  );

  const sum =
    state.kind === "error"
      ? `<p class="reply-error">Fils illisibles : ${esc(state.message)}</p>`
      : `<p class="open-sum">${count("human")} attendent l'humain · ${count("agent")} attendent un agent</p>`;

  menu.innerHTML = `<h2>Points ouverts</h2>${sum}<ul>${rows.join("")}</ul>`;
}

export function renderCrumbs(crumbs: HTMLElement, place: Place): void {
  const current = 'aria-current="true"';

  const parts = [
    `<button type="button" data-go="" ${place.zone === null && place.node === null ? current : ""}>Bookshop</button>`,
  ];

  if (place.zone !== null) {
    const title = esc(zone(place.zone).title);
    parts.push(
      `<span class="sep">›</span><button type="button" data-go="${place.zone}" ${place.node === null ? current : ""}>${title}</button>`,
    );
  }

  if (place.node !== null) {
    parts.push(
      `<span class="sep">›</span><button type="button" ${current}>${esc(node(place.node).label)}</button>`,
    );
  }

  crumbs.innerHTML = parts.join("");
}
