import type { AtlasMap } from "./atlas.ts";
import { keptMarkup, mapHtmlFields } from "./markup.ts";

// A citation is the text of a <cite> that names a file and lines of it: `<path>:<lines>`, the
// lines a line, a range `first-last`, or a comma list of those, as `src/serve.ts:380` or
// `orders.go:30,44-46`. The panel shows it as a marker of its lines, `check` verifies it against
// the folder the Config's `sources` names, and serve.ts answers its lines. Any other <cite> is a
// title, shown as written.

/** Lines `first` to `last` of a file, counted from 1; one line has `first === last`. */
export type Lines = { readonly first: number; readonly last: number };

export type Citation = { readonly path: string; readonly lines: readonly Lines[] };

// A path holds no space, no colon, and nothing that would end an HTML text or attribute.
const CITATION = /^([^\s:<>&"']+):(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)$/u;

const isLine = (n: number): boolean => Number.isSafeInteger(n) && n >= 1;

function linesOf(range: string): Lines | null {
  const [first = Number.NaN, last = first] = range.split("-").map(Number);

  return isLine(first) && isLine(last) && first <= last ? { first, last } : null;
}

/** The citation `text` is, or null for a <cite> of any other text. */
export function citationOf(text: string): Citation | null {
  const [, path, list] = CITATION.exec(text) ?? [];

  if (path === undefined || list === undefined) {
    return null;
  }

  const lines = list.split(",").map((range) => linesOf(range));

  return lines.every((l) => l !== null) ? { path, lines } : null;
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

/** Every citation in the map's HTML fields, by "root" or "node <id>" and field, in panel order. */
export const mapCitations = (map: AtlasMap): Cited[] =>
  mapHtmlFields(map).flatMap(({ where, field, text }) =>
    [...keptMarkup(text).matchAll(CITE)].flatMap(([, cited = ""]) => {
      const citation = citationOf(cited);

      return citation === null ? [] : [{ where, field, citation }];
    }),
  );
