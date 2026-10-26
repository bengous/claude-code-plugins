import type { AtlasMap } from "./atlas.ts";
import { keptMarkup, mapHtmlFields } from "./markup.ts";

// A citation is the text of a <cite> that names a file and lines of it: `<path>:<lines>`, the
// lines a line, a range `first-last`, or a comma list of those, as `src/serve.ts:380` or
// `orders.go:30, 44-46`. The panel shows it as a marker of its lines, `check` verifies it against
// the folder the Config's `sources` names, and serve.ts answers its lines. Any other <cite> is a
// title, shown as written; `check` names one that looks like a citation but reads as none.

/** Lines `first` to `last` of a file, counted from 1; one line has `first === last`. */
export type Lines = { readonly first: number; readonly last: number };

export type Citation = { readonly path: string; readonly lines: readonly Lines[] };

/** What a <cite>'s text reads as: a citation, one that looks like a citation but is none, a title. */
export type CiteText =
  | { readonly kind: "citation"; readonly citation: Citation }
  | { readonly kind: "broken"; readonly why: string }
  | { readonly kind: "title" };

// A path holds no space, no colon, nothing that would end an HTML text or attribute, and a slash
// or a dot, as a file's path does: `redis:6379` names a host and its port. What follows its colon
// looks like lines from its first mark on, so LINE_LIST tells a citation from a broken one.
const CITED = /^([^\s:<>&"']*[./][^\s:<>&"']*):(\s*[\d,L-].*)$/su;

const LINE_LIST = /^\d+(?:-\d+)?(?:, ?\d+(?:-\d+)?)*$/u;

const isLine = (n: number): boolean => Number.isSafeInteger(n) && n >= 1;

const broken = (why: string): CiteText => ({ kind: "broken", why });

/** What the text of a <cite> reads as. */
export function citeOf(text: string): CiteText {
  const [, path, list] = CITED.exec(text.trim()) ?? [];

  if (path === undefined || list === undefined) {
    return { kind: "title" };
  }

  if (!LINE_LIST.test(list)) {
    return broken("the lines are a line, a range first-last, or a comma list of those");
  }

  const lines: Lines[] = [];

  for (const range of list.split(/, ?/u)) {
    const [first = Number.NaN, last = first] = range.split("-").map(Number);

    if (!isLine(first) || !isLine(last)) {
      return broken(`lines count from 1: ${range}`);
    }

    if (first > last) {
      return broken(`the range ${range} runs backwards`);
    }

    lines.push({ first, last });
  }

  return { kind: "citation", citation: { path, lines } };
}

/** The citation `text` is, or null for a <cite> of any other text. */
export function citationOf(text: string): Citation | null {
  const read = citeOf(text);

  return read.kind === "citation" ? read.citation : null;
}

/** The lines of a citation as a marker shows them: `380`, `452-453`, `30,44-46`. */
export const citedLines = (citation: Citation): string =>
  citation.lines
    .map(({ first, last }) => (first === last ? String(first) : `${first}-${last}`))
    .join(",");

/** The whole citation, `path:lines`, as its tooltip shows it. */
export const citationText = (citation: Citation): string =>
  `${citation.path}:${citedLines(citation)}`;

// A <cite> as keptMarkup writes it, its text with no tag inside.
const CITE = /<cite>([^<]*)<\/cite>/gu;

/** Markup as keptMarkup wrote it, each <cite> holding a citation replaced by what `shown` makes. */
export const withCitations = (kept: string, shown: (citation: Citation) => string): string =>
  kept.replaceAll(CITE, (cite: string, text: string) => {
    const citation = citationOf(text);

    return citation === null ? cite : shown(citation);
  });

export type Cited = { readonly where: string; readonly field: string; readonly citation: Citation };

type Cite = { readonly where: string; readonly field: string; readonly text: string };

const mapCites = (map: AtlasMap): Cite[] =>
  mapHtmlFields(map).flatMap(({ where, field, text }) =>
    [...keptMarkup(text).matchAll(CITE)].map(([, cited = ""]) => ({ where, field, text: cited })),
  );

/** Every citation in the map's HTML fields, by "root" or "node <id>" and field, in panel order. */
export const mapCitations = (map: AtlasMap): Cited[] =>
  mapCites(map).flatMap(({ where, field, text }) => {
    const citation = citationOf(text);

    return citation === null ? [] : [{ where, field, citation }];
  });

export type Broken = Cite & { readonly why: string };

/** Every <cite> of the map's HTML fields that looks like a citation but reads as none, and why. */
export const mapBrokenCitations = (map: AtlasMap): Broken[] =>
  mapCites(map).flatMap((cite) => {
    const read = citeOf(cite.text);

    return read.kind === "broken" ? [{ ...cite, why: read.why }] : [];
  });
