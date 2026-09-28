import type { Element, Root, RootContent } from "hast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

import type { Passage } from "../../runtime/protocol.ts";
import type { Place } from "./protocol.ts";

/** As many characters of context as `passageFromRange` in `runtime/page/anchoring.ts` keeps. */
const CONTEXT_CHARS = 32;

/** How far from its stated lines a quote is still taken: the agent misnumbers lines more often than it misquotes. */
const LINE_TOLERANCE = 5;

/**
 * The Markdown parsed as `markdown/tree.ts` renders it, which this extension may not import:
 * the page matches a quote in the rendered text, where no markup, link target or raw HTML is.
 */
const processor = unified().use(remarkParse).use(remarkGfm).use(remarkRehype);

/** The text the page shows, and for each of its characters the source line it comes from, `null` between blocks. */
type Shown = {
  readonly text: string;
  readonly lines: readonly (number | null)[];
  readonly code: readonly boolean[];
};

function isMermaid(element: Element): boolean {
  const code = element.children[0];
  const classes = code?.type === "element" ? code.properties.className : undefined;

  return (
    element.tagName === "pre" && Array.isArray(classes) && classes.includes("language-mermaid")
  );
}

/** A code block's text has no position: its first line follows the fence, when there is one. */
function codeLine(pre: Element, value: string): number | null {
  if (pre.position === undefined) return null;
  const { start, end } = pre.position;
  const fenced = end.line - start.line + 1 > value.split("\n").length - 1;

  return start.line + (fenced ? 1 : 0);
}

/** A diagram's source is left out, since the page draws it instead. */
function shownOf(tree: Root): Shown {
  const parts: string[] = [];
  const lines: (number | null)[] = [];
  const code: boolean[] = [];

  const visit = (node: Root | RootContent, pre: Element | null): void => {
    if (node.type === "text") {
      let line = pre === null ? (node.position?.start.line ?? null) : codeLine(pre, node.value);
      parts.push(node.value);

      // By UTF-16 unit, as `indexOf` counts: `for…of` walks code points.
      for (let index = 0; index < node.value.length; index += 1) {
        lines.push(line);
        code.push(pre !== null);

        if (node.value[index] === "\n" && line !== null) line += 1;
      }
    } else if (node.type === "root" || (node.type === "element" && !isMermaid(node))) {
      const inside = node.type === "element" && node.tagName === "pre" ? node : pre;

      for (const child of node.children) visit(child, inside);
    }
  };

  visit(tree, null);

  return { text: parts.join(""), lines, code };
}

function distance(line: number, [first, last]: readonly [number, number]): number {
  return Math.max(first - line, line - last, 0);
}

/**
 * The finding's place in the version's Markdown as a `Passage` the page re-finds with `rangeFor`:
 * the occurrence of the quote in the rendered text nearest its lines, within `LINE_TOLERANCE`,
 * on the lines it really spans, its context the rendered text around it. `null` when the page
 * does not show the quote there.
 */
export function passageOf(text: string, place: Place): Passage | null {
  const { quote } = place;

  if (quote.trim() === "") return null;
  const shown = shownOf(processor.runSync(processor.parse(text)));
  let best: { readonly at: number; readonly off: number } | null = null;

  for (let at = shown.text.indexOf(quote); at !== -1; at = shown.text.indexOf(quote, at + 1)) {
    const line = shown.lines[at] ?? null;
    const off = line === null ? Infinity : distance(line, place.lines);

    if (off <= LINE_TOLERANCE && (best === null || off < best.off)) best = { at, off };
  }

  if (best === null) return null;
  const { at } = best;
  const first = shown.lines[at] ?? null;
  const last = shown.lines[at + quote.length - 1] ?? null;

  if (first === null || last === null) return null;

  return {
    kind: shown.code[at] === true ? "code" : "prose",
    quote,
    prefix: shown.text.slice(Math.max(0, at - CONTEXT_CHARS), at),
    suffix: shown.text.slice(at + quote.length, at + quote.length + CONTEXT_CHARS),
    lines: [first, last],
    removed: false,
  };
}
