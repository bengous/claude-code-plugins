import type { OpenPoint, Pair, Panel } from "../model/atlas.ts";
import { keptMarkup } from "../model/markup.ts";
import type { Place } from "../model/navigation.ts";
import type { Crumb } from "../model/navigation.ts";
import { crumbsOf, foldedCrumbs, openOf } from "../model/navigation.ts";
import type { Settings } from "../model/settings.ts";
import { paletteVar } from "../model/settings.ts";
import type { Entry, Threads, Who } from "../model/threads.ts";
import { firstLine, openItems, waitsFor } from "../model/threads.ts";
import type { Tree } from "../model/tree.ts";
import { chainOf, couplingsOf, nodeOf } from "../model/tree.ts";
import { esc } from "./svg.ts";

// The panel shows the fields of Panel (atlas.ts) in their order: the HTML fields through
// keptMarkup (markup.ts), which shows any tag but a few plain ones as text, so a map's text runs
// nothing in the page that holds the reply token; the plain fields, ids and labels escaped.
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
    `<p class="warn">${keptMarkup(o.text)}</p>`,
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

function chip(tree: Tree, id: string): string {
  const node = tree.nodes.get(id);

  if (node === undefined) {
    return "";
  }

  const label = esc(node.label.replaceAll("\n", " "));

  return `<button type="button" class="chip" data-go="${esc(id)}" style="--zc: var(${paletteVar(node.color)})"><span class="dot"></span>${label}</button>`;
}

const pointList = (tree: Tree, items: readonly Pair[]): string =>
  `<ul class="points">${items.map(([id, t]) => `<li>${keptMarkup(t)} ${chip(tree, id)}</li>`).join("")}</ul>`;

const pairs = (items: readonly Pair[], escape: boolean): string =>
  items.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${escape ? esc(v) : keptMarkup(v)}</dd>`).join("");

const list = (items: readonly string[], escape: boolean): string =>
  items.map((i) => `<li>${escape ? esc(i) : keptMarkup(i)}</li>`).join("");

function replaceSection(s: Settings, tree: Tree, info: Panel, coupled: readonly string[]): string {
  if (info.swap === undefined && coupled.length === 0) {
    return "";
  }

  const swap = info.swap === undefined ? "" : `<p>${keptMarkup(info.swap)}</p>`;

  const chips =
    coupled.length === 0
      ? ""
      : `<p class="label">${s.words.coupledWith}</p><div class="chips">${coupled.map((id) => chip(tree, id)).join("")}</div>`;

  return `<h3>${s.words.swap}</h3>${swap}${chips}`;
}

// The sections after the contract, in panel order: [heading, body] or "".
function laterSections(
  s: Settings,
  tree: Tree,
  info: Panel,
  open: readonly OpenPoint[] | undefined,
  state: ThreadState,
): string {
  const w = s.words;

  return [
    info.extend === undefined ? "" : `<h3>${w.extend}</h3><p>${keptMarkup(info.extend)}</p>`,
    info.pitfalls === undefined || info.pitfalls.length === 0
      ? ""
      : `<h3>${w.pitfalls}</h3><ul>${list(info.pitfalls, false)}</ul>`,
    info.seams === undefined ? "" : `<h3>${w.seams}</h3>${pointList(tree, info.seams)}`,
    info.traps === undefined ? "" : `<h3>${w.traps}</h3>${pointList(tree, info.traps)}`,
    info.why === undefined || info.why.length === 0
      ? ""
      : `<h3>${w.why}</h3><ul>${list(info.why, false)}</ul>`,
    info.alt === undefined ? "" : `<h3>${w.alt}</h3><p class="alt">${keptMarkup(info.alt)}</p>`,
    info.facts === undefined
      ? ""
      : `<h3>${w.facts}</h3><dl class="facts">${pairs(info.facts, true)}</dl>`,
    openSection(s, open, state),
    info.how === undefined ? "" : `<h3>${w.how}</h3><p>${keptMarkup(info.how)}</p>`,
  ].join("");
}

type Shown = {
  readonly info: Panel;
  readonly title: string;
  readonly color: string;
  readonly brief: readonly string[];
  readonly coupled: readonly string[];
  readonly open: readonly OpenPoint[] | undefined;
  readonly extra: string;
};

function renderInfo(s: Settings, tree: Tree, shown: Shown, state: ThreadState): string {
  const { info } = shown;

  return [
    `<div style="--zc: var(${shown.color})">`,
    info.kicker === undefined ? "" : `<p class="kicker">${esc(info.kicker)}</p>`,
    `<h2><span class="swatch"></span>${keptMarkup(shown.title)}</h2>`,
    info.lead === undefined ? "" : `<p class="lead">${keptMarkup(info.lead)}</p>`,
    shown.brief.length === 0 ? "" : `<ul class="brief">${list(shown.brief, true)}</ul>`,
    info.io === undefined
      ? ""
      : `<h3>${s.words.io}</h3><dl class="facts io">${pairs(info.io, false)}</dl>`,
    replaceSection(s, tree, info, shown.coupled),
    laterSections(s, tree, info, shown.open, state),
    shown.extra,
    info.see === undefined || info.see.length === 0
      ? ""
      : `<h3>${s.words.see}</h3><div class="chips">${info.see.map((id) => chip(tree, id)).join("")}</div>`,
    info.src === undefined ? "" : `<p class="src">${s.words.source(esc(info.src))}</p>`,
    "</div>",
  ].join("");
}

/** The containers in the root's `tour`, or every container depth-first. */
export const tourOf = (tree: Tree): readonly string[] =>
  tree.map.root.tour ??
  [...tree.nodes.values()].flatMap((n) => (n.children === undefined ? [] : [n.id]));

function tourNav(tree: Tree, id: string): string {
  const order = tourOf(tree);
  const i = order.indexOf(id);

  if (i === -1) {
    return "";
  }

  const prev = nodeOf(tree, order[(i + order.length - 1) % order.length] ?? id);
  const next = nodeOf(tree, order[(i + 1) % order.length] ?? id);

  return `<div class="nav"><button type="button" data-go="${esc(prev.id)}">← ${esc(prev.label)}</button><button type="button" data-go="${esc(next.id)}">${esc(next.label)} →</button></div>`;
}

const upNav = (tree: Tree, id: string): string => {
  const parent = chainOf(tree, id).at(-2);

  return parent === undefined
    ? ""
    : `<div class="nav"><button type="button" data-go="${esc(parent)}">↑ ${esc(nodeOf(tree, parent).label)}</button></div>`;
};

const arrowsMissing = (s: Settings, avoidError: string | null): string =>
  avoidError === null
    ? ""
    : `<h3>${s.words.arrowsMissing}</h3><p class="warn">${s.words.avoidFailed(esc(avoidError))}</p>`;

function rootExtra(s: Settings, tree: Tree): string {
  const chips = tourOf(tree)
    .map((id) => chip(tree, id))
    .join("");

  return chips === "" ? "" : `<h3>${s.words.zones}</h3><div class="chips">${chips}</div>`;
}

export function renderPanel(
  s: Settings,
  tree: Tree,
  panel: Pick<HTMLElement, "innerHTML" | "scrollTop">,
  place: Place,
  avoidError: string | null,
  state: ThreadState,
): void {
  const id = place.selected ?? openOf(place);

  if (id === null) {
    const { title, children: _children, tour: _tour, ...info } = tree.map.root;

    panel.innerHTML = renderInfo(
      s,
      tree,
      {
        info,
        title,
        color: "--accent",
        brief: [],
        coupled: [],
        open: undefined,
        extra: rootExtra(s, tree) + arrowsMissing(s, avoidError),
      },
      state,
    );
  } else {
    const node = nodeOf(tree, id);

    const shown: Shown = {
      info: node,
      title: node.title ?? node.label,
      color: paletteVar(node.color),
      brief: node.brief ?? [],
      coupled: couplingsOf(tree, id),
      open: node.open,
      extra: arrowsMissing(s, avoidError),
    };

    const nav = place.selected === null ? tourNav(tree, id) : upNav(tree, id);
    panel.innerHTML = renderInfo(s, tree, shown, state) + nav;
  }

  panel.scrollTop = 0;
}

// The header button and the list it opens: one row per open point, a click goes to its node.
export function renderOpenList(
  s: Settings,
  tree: Tree,
  button: HTMLButtonElement,
  menu: HTMLElement,
  state: ThreadState,
): void {
  const items = openItems(tree);

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

// On one line: the levels folded (foldedCrumbs) name themselves in the fold's tooltip.
export function renderCrumbs(
  s: Settings,
  tree: Tree,
  crumbs: Pick<HTMLElement, "innerHTML">,
  place: Place,
): void {
  const all = crumbsOf(tree, place);
  const last = all.at(-1);
  const anySelected = all.some((c) => c.kind === "node" && c.selected);
  const labelOf = (crumb: Crumb): string => (crumb.kind === "root" ? s.title : crumb.label);

  const button = (crumb: Crumb): string => {
    const here = anySelected ? crumb.kind === "node" && crumb.selected : crumb === last;
    const current = here ? ' aria-current="true"' : "";
    const go = crumb.kind === "root" ? "" : crumb.id;
    const label = esc(labelOf(crumb));

    return `<button type="button" data-go="${esc(go)}" title="${label}"${current}>${label}</button>`;
  };

  const parts = foldedCrumbs(all).map((shown, i) => {
    const part =
      shown.kind === "fold"
        ? `<span class="fold" title="${esc(shown.crumbs.map(labelOf).join(" › "))}">…</span>`
        : button(shown);

    return i === 0 ? part : `<span class="sep">›</span>${part}`;
  });

  crumbs.innerHTML = parts.join("");
}
