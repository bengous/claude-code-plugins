import type { Journey, Node, OpenPoint, Pair, Panel, PanelHeading } from "../model/atlas.ts";
import type { Cards } from "../model/cards.ts";
import type { Citation } from "../model/citations.ts";
import { citationText, citedLines, withCitations } from "../model/citations.ts";
import { joins } from "../model/journeys.ts";
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
// fieldHtml, keptMarkup (markup.ts), which shows any tag but a few plain ones as text, so a map's
// text runs nothing in the page that holds the reply token, then each citation as a marker of its
// lines; the plain fields, ids, labels and the headings the settings hold, the Config's or the
// dictionary's, escaped.
//
// threads.json as the page last read it, or why it could not.
export type ThreadState =
  | { readonly kind: "ok"; readonly threads: Threads }
  | { readonly kind: "error"; readonly message: string };

const heading = (s: Settings, key: PanelHeading): string => esc(s.headings[key]);

// The path hides until the panel shows the sources in full (`full-sources`, atlas.html). With a
// sources root, a marker is a button that opens its lines (engine.ts).
function marker(s: Settings, citation: Citation): string {
  const whole = esc(citationText(citation));
  const shown = `<span class="cite-path">${esc(citation.path)}:</span>${citedLines(citation)}`;

  return s.sources === null
    ? `<cite class="cite" title="${whole}">${shown}</cite>`
    : `<cite class="cite" title="${whole}"><button type="button" class="cite-open" data-cite="${whole}" aria-label="${whole}">${shown}</button></cite>`;
}

/** An HTML field of a map as every part of the panel shows it: its kept markup, its markers. */
export const fieldHtml = (s: Settings, html: string): string =>
  withCitations(keptMarkup(html), (citation) => marker(s, citation));

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
    `<p class="warn">${fieldHtml(s, o.text)}</p>`,
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

const pointList = (s: Settings, tree: Tree, items: readonly Pair[]): string =>
  `<ul class="points">${items.map(([id, t]) => `<li>${fieldHtml(s, t)} ${chip(tree, id)}</li>`).join("")}</ul>`;

const pairs = (s: Settings, items: readonly Pair[], escape: boolean): string =>
  items.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${escape ? esc(v) : fieldHtml(s, v)}</dd>`).join("");

const list = (s: Settings, items: readonly string[], escape: boolean): string =>
  items.map((i) => `<li>${escape ? esc(i) : fieldHtml(s, i)}</li>`).join("");

function replaceSection(s: Settings, tree: Tree, info: Panel, coupled: readonly string[]): string {
  if (info.swap === undefined && coupled.length === 0) {
    return "";
  }

  const swap = info.swap === undefined ? "" : `<p>${fieldHtml(s, info.swap)}</p>`;

  const chips =
    coupled.length === 0
      ? ""
      : `<p class="label">${heading(s, "coupledWith")}</p><div class="chips">${coupled.map((id) => chip(tree, id)).join("")}</div>`;

  return `<h3>${heading(s, "swap")}</h3>${swap}${chips}`;
}

// The sections after the contract, in panel order: [heading, body] or "".
function laterSections(
  s: Settings,
  tree: Tree,
  info: Panel,
  open: readonly OpenPoint[] | undefined,
  state: ThreadState,
): string {
  const h = (key: PanelHeading): string => `<h3>${heading(s, key)}</h3>`;

  return [
    info.extend === undefined ? "" : `${h("extend")}<p>${fieldHtml(s, info.extend)}</p>`,
    info.pitfalls === undefined || info.pitfalls.length === 0
      ? ""
      : `${h("pitfalls")}<ul>${list(s, info.pitfalls, false)}</ul>`,
    info.seams === undefined ? "" : `${h("seams")}${pointList(s, tree, info.seams)}`,
    info.traps === undefined ? "" : `${h("traps")}${pointList(s, tree, info.traps)}`,
    info.why === undefined || info.why.length === 0
      ? ""
      : `${h("why")}<ul>${list(s, info.why, false)}</ul>`,
    info.alt === undefined ? "" : `${h("alt")}<p class="alt">${fieldHtml(s, info.alt)}</p>`,
    info.facts === undefined
      ? ""
      : `${h("facts")}<dl class="facts">${pairs(s, info.facts, true)}</dl>`,
    openSection(s, open, state),
    info.how === undefined ? "" : `${h("how")}<p>${fieldHtml(s, info.how)}</p>`,
  ].join("");
}

type Shown = {
  readonly info: Panel;
  /** The heading as HTML: a `title` through fieldHtml, or a label, plain text, escaped. */
  readonly heading: string;
  readonly color: string;
  readonly brief: readonly string[];
  /** Its work phase, one of the Config's; null without one. */
  readonly phase: string | null;
  readonly coupled: readonly string[];
  readonly open: readonly OpenPoint[] | undefined;
  readonly extra: string;
};

function renderInfo(s: Settings, tree: Tree, shown: Shown, state: ThreadState): string {
  const { info } = shown;

  return [
    `<div style="--zc: var(${shown.color})">`,
    info.kicker === undefined ? "" : `<p class="kicker">${esc(info.kicker)}</p>`,
    `<h2><span class="swatch"></span>${shown.heading}</h2>`,
    info.lead === undefined ? "" : `<p class="lead">${fieldHtml(s, info.lead)}</p>`,
    shown.brief.length === 0 ? "" : `<ul class="brief">${list(s, shown.brief, true)}</ul>`,
    shown.phase === null ? "" : `<h3>${heading(s, "phase")}</h3><p>${esc(shown.phase)}</p>`,
    info.io === undefined
      ? ""
      : `<h3>${heading(s, "io")}</h3><dl class="facts io">${pairs(s, info.io, false)}</dl>`,
    replaceSection(s, tree, info, shown.coupled),
    laterSections(s, tree, info, shown.open, state),
    shown.extra,
    info.see === undefined || info.see.length === 0
      ? ""
      : `<h3>${heading(s, "see")}</h3><div class="chips">${info.see.map((id) => chip(tree, id)).join("")}</div>`,
    info.src === undefined ? "" : `<p class="src">${s.words.source(esc(info.src))}</p>`,
    "</div>",
  ].join("");
}

/**
 * The side of a panel's ← → button, the tour's or a journey's, disabled ones included: written
 * anew with the panel, the one that held the focus hands it to its new copy (engine.ts).
 */
type Nav = "previous" | "next";

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

  return `<div class="nav"><button type="button" data-nav="previous" data-go="${esc(prev.id)}">← ${esc(prev.label)}</button><button type="button" data-nav="next" data-go="${esc(next.id)}">${esc(next.label)} →</button></div>`;
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
        heading: fieldHtml(s, title),
        color: "--accent",
        brief: [],
        phase: null,
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
      heading: node.title === undefined ? esc(node.label) : fieldHtml(s, node.title),
      color: paletteVar(node.color),
      brief: node.brief ?? [],
      phase: node.phase !== undefined && s.phases.includes(node.phase) ? node.phase : null,
      coupled: couplingsOf(tree, id),
      open: node.open,
      extra: arrowsMissing(s, avoidError),
    };

    const nav = place.selected === null ? tourNav(tree, id) : upNav(tree, id);
    panel.innerHTML = renderInfo(s, tree, shown, state) + nav;
  }

  panel.scrollTop = 0;
}

/**
 * A journey's step, 1 to its count, in place of the panel's fields: the journey's label, the
 * step's place in it, the label of the link it follows (joins) over its ends' labels, its note,
 * the buttons to the steps before and after it, disabled past either end, and under them the one
 * that leaves the journey. The labels and the note are plain text, shown as written.
 */
export function renderJourney(
  s: Settings,
  tree: Tree,
  panel: Pick<HTMLElement, "innerHTML" | "scrollTop">,
  journey: Journey,
  step: number,
  avoidError: string | null,
): void {
  const shown = journey.steps[step - 1];

  if (shown === undefined) {
    throw new RangeError(`journey ${journey.id}: no step ${step} of ${journey.steps.length}`);
  }

  const label = tree.map.links.find((link) => joins(link, shown))?.label;

  const ends = [shown.from, shown.to]
    .map((id) => esc(nodeOf(tree, id).label.replaceAll("\n", " ")))
    .join(" → ");

  const button = (nav: Nav, to: number, text: string): string =>
    to >= 1 && to <= journey.steps.length
      ? `<button type="button" data-nav="${nav}" data-step="${to}">${text}</button>`
      : `<button type="button" data-nav="${nav}" disabled>${text}</button>`;

  panel.innerHTML = [
    `<div class="journey" style="--zc: var(--accent)">`,
    `<p class="kicker">${s.words.journeysButton}</p>`,
    `<h2><span class="swatch"></span>${esc(journey.label)}</h2>`,
    `<p class="journey-step">${s.words.stepOf(step, journey.steps.length)}</p>`,
    `<p class="journey-arrow">`,
    label === undefined ? "" : `<span class="journey-label">${esc(label)}</span>`,
    `<span class="journey-ends">${ends}</span></p>`,
    shown.note === undefined ? "" : `<p class="lead">${esc(shown.note)}</p>`,
    arrowsMissing(s, avoidError),
    `<div class="nav">${button("previous", step - 1, s.words.previousStep)}${button("next", step + 1, s.words.nextStep)}</div>`,
    `<div class="leave"><button type="button" data-leave>${s.words.leaveJourney}</button></div>`,
    `</div>`,
  ].join("");
  panel.scrollTop = 0;
}

/** The header's menu: a row per journey, its label and its count of steps, the one played current. */
export function journeysHtml(
  s: Settings,
  journeys: readonly Journey[],
  played: string | null,
): string {
  const rows = journeys.map((journey) => {
    const current = journey.id === played ? ' aria-current="true"' : "";

    return `<li><button type="button" class="journey-row" data-journey="${esc(journey.id)}"${current}><span>${esc(journey.label)}</span><span class="journey-count">${s.words.stepCount(journey.steps.length)}</span></button></li>`;
  });

  return `<h2>${s.words.journeysButton}</h2><ul>${rows.join("")}</ul>`;
}

/** Consecutive lines of a file, the first numbered `from`. */
export type Stretch = { readonly from: number; readonly lines: readonly string[] };

/**
 * The lines a clicked marker cites, which the panel shows in place of its fields: their stretches
 * in the file's order, or a file too large to show.
 */
export type Viewer =
  | { readonly kind: "loading"; readonly citation: Citation }
  | { readonly kind: "lines"; readonly citation: Citation; readonly stretches: readonly Stretch[] }
  | { readonly kind: "large"; readonly citation: Citation }
  | { readonly kind: "failed"; readonly citation: Citation; readonly message: string };

const CONTEXT = 8;

/** Lines `from` to `to` of a file, as the viewer asks serve.ts for them. */
export type LineSpan = { readonly from: number; readonly to: number };

/**
 * The spans the viewer asks for, in the file's order: each cited line or range with CONTEXT
 * lines around it, two spans joined when at most one line lies between them.
 */
export function linesAround(citation: Citation): LineSpan[] {
  const around = citation.lines
    .map(({ first, last }) => ({ from: Math.max(1, first - CONTEXT), to: last + CONTEXT }))
    .toSorted((a, b) => a.from - b.from);

  const spans: LineSpan[] = [];

  for (const span of around) {
    const before = spans.at(-1);

    if (before !== undefined && span.from <= before.to + 2) {
      spans[spans.length - 1] = { from: before.from, to: Math.max(before.to, span.to) };
    } else {
      spans.push(span);
    }
  }

  return spans;
}

const isCited = (citation: Citation, n: number): boolean =>
  citation.lines.some(({ first, last }) => n >= first && n <= last);

const GAP = '<div class="line gap"><span class="n">…</span></div>';

function viewerBody(s: Settings, viewer: Viewer): string {
  switch (viewer.kind) {
    case "loading": {
      return `<p class="viewer-note">${s.words.viewerLoading}</p>`;
    }

    case "failed": {
      return `<p class="warn">${s.words.viewerFailed(esc(viewer.message))}</p>`;
    }

    case "large": {
      return `<p class="viewer-note">${s.words.viewerTooLarge}</p>`;
    }

    case "lines": {
      const stretches = viewer.stretches.map(({ from, lines }) =>
        lines
          .map((text, i) => {
            const n = from + i;
            const cited = isCited(viewer.citation, n) ? " cited" : "";

            return `<div class="line${cited}"><span class="n">${n}</span><code>${esc(text)}</code></div>`;
          })
          .join(""),
      );

      return `<div class="viewer-lines">${stretches.join(GAP)}</div>`;
    }
  }
}

// The path and the close button above the lines, each line with its number, the cited ones marked,
// a "…" row between two stretches apart.
export function renderViewer(
  s: Settings,
  panel: Pick<HTMLElement, "innerHTML" | "scrollTop">,
  viewer: Viewer,
): void {
  panel.innerHTML = [
    `<div class="viewer">`,
    `<div class="viewer-head"><code class="viewer-path">${esc(citationText(viewer.citation))}</code>`,
    `<button type="button" class="viewer-close" data-close-viewer>${s.words.viewerClose}</button></div>`,
    viewerBody(s, viewer),
    `</div>`,
  ].join("");
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

const classOf = (names: readonly string[]): string =>
  names.length === 0 ? "" : ` class="${names.join(" ")}"`;

function cardHead(node: Node, selected: boolean, names: readonly string[]): string {
  const current = selected ? ' aria-current="true"' : "";
  const label = esc(node.label.replaceAll("\n", " "));

  return `<th scope="col"${classOf(names)} style="--zc: var(${paletteVar(node.color)})"><button type="button" data-select="${esc(node.id)}"${current}>${label}</button></th>`;
}

const cell = (s: Settings, values: readonly string[], names: readonly string[]): string =>
  `<td${classOf(names)}>${values.map((value) => `<p>${fieldHtml(s, value)}</p>`).join("")}</td>`;

/**
 * A container's leaf children side by side (cardsOf), as a table: a column per leaf, its header
 * its label in its colour, a button that selects it, the selected one's cells marked; the first
 * row their leads, unless none has one, then a row per `io` key, its key as the panel shows it, its values through
 * fieldHtml, the panel's markup and markers kept. The columns of the leaves in `later`, which the
 * phase picked dims, are marked later.
 */
export function cardsHtml(
  s: Settings,
  cards: Cards,
  selected: string | null,
  later: ReadonlySet<string> = new Set(),
): string {
  const marked = cards.columns.map((node) => node.id === selected);

  const mark = (i: number): string[] => [
    ...(marked[i] === true ? ["selected"] : []),
    ...(later.has(cards.columns[i]?.id ?? "") ? ["later"] : []),
  ];

  const head = cards.columns.map((node, i) => cardHead(node, marked[i] === true, mark(i))).join("");

  const lead =
    cards.lead === null
      ? []
      : [
          `<tr><td></td>${cards.lead.map((text, i) => cell(s, text === null ? [] : [text], ["lead", ...mark(i)])).join("")}</tr>`,
        ];

  const rows = cards.rows.map(
    (row) =>
      `<tr><th scope="row">${esc(row.key)}</th>${row.cells.map((values, i) => cell(s, values, mark(i))).join("")}</tr>`,
  );

  return `<table><thead><tr><td></td>${head}</tr></thead><tbody>${[...lead, ...rows].join("")}</tbody></table>`;
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
