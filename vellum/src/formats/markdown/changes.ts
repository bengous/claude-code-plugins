import type { Element, Root } from "hast";

import { parseLines } from "../../runtime/page/anchoring.ts";
import type { DiffRun, LineDiff } from "../../runtime/protocol.ts";

/**
 * What "Changes since" draws over the rendered plan: which blocks carry the green bar, and
 * where each removed run shows its old source. Pure, over the hast of `tree.ts`.
 */

export type RemovedRun = Extract<DiffRun, { readonly kind: "removed" }>;

/**
 * A removed run is drawn before the block that follows it, with one exception a `details`
 * forces: no child of a list, it goes inside the item, after its checkbox when it has one. Before
 * a row it is drawn as a row of its own, which the renderer makes. A code block also says which
 * of its lines were added, by their index in the block.
 */
export type Changes = {
  readonly marked: ReadonlySet<Element>;
  readonly addedLines: ReadonlyMap<Element, readonly number[]>;
  readonly removedBefore: ReadonlyMap<Element, readonly RemovedRun[]>;
  readonly removedInside: ReadonlyMap<Element, readonly RemovedRun[]>;
  readonly removedAtEnd: readonly RemovedRun[];
};

export function removedLabel(count: number): string {
  return `${count} ${count === 1 ? "line" : "lines"} removed`;
}

export const BLOCK_TAGS: ReadonlySet<string> = new Set([
  "p",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "pre",
  "tr",
  "blockquote",
  "hr",
]);

type Block = {
  readonly element: Element;
  readonly start: number;
  readonly end: number;
  /** A loose item's only paragraph hands its mark to the item, so the item looks the same tight or loose. */
  readonly marks: Element;
};

/** The blocks under `node` in document order, each with its own `data-lines`: an `li` stops before its nested list. */
function blocksOf(node: Root | Element, parent: Block | null): Block[] {
  return node.children.flatMap((child) => {
    if (child.type !== "element") return [];
    const lines = parseLines(String(child.properties.dataLines));

    if (lines === null || !BLOCK_TAGS.has(child.tagName)) return blocksOf(child, null);
    const [start, end] = lines;

    const item =
      child.tagName === "p" &&
      parent?.element.tagName === "li" &&
      parent.start === start &&
      parent.end === end
        ? parent.element
        : null;

    const block = { element: child, start, end, marks: item ?? child };

    return [block, ...blocksOf(child, block)];
  });
}

function add<T>(to: Map<Element, T[]>, anchor: Element, item: T): void {
  to.set(anchor, [...(to.get(anchor) ?? []), item]);
}

/**
 * A fence may be closed by the end of its quote, its item or the file rather than by a fence
 * line, so a fenced block's last code line is counted, not read off `data-lines`. The text of a
 * non-empty code block ends with a newline (mdast-util-to-hast adds it), so it holds one per line.
 */
function newlinesIn(node: Element): number {
  return node.children.reduce(
    (count, child) =>
      count +
      (child.type === "text" ? child.value.split(/\r\n|\r|\n/u).length - 1 : 0) +
      (child.type === "element" ? newlinesIn(child) : 0),
    0,
  );
}

export function changesOf(tree: Root, diff: LineDiff): Changes {
  const blocks = blocksOf(tree, null);
  const marked = new Set<Element>();
  const addedLines = new Map<Element, number[]>();
  const removedBefore = new Map<Element, RemovedRun[]>();
  const removedInside = new Map<Element, RemovedRun[]>();
  const removedAtEnd: RemovedRun[] = [];

  for (const run of diff) {
    if (run.kind === "added") {
      for (let line = run.after; line < run.after + run.count; line += 1) {
        const innermost = blocks.findLast((block) => block.start <= line && line <= block.end);

        if (innermost === undefined) continue;
        marked.add(innermost.marks);

        if (innermost.element.tagName === "pre") {
          const fenced = innermost.element.properties.dataFenced === true;
          const first = fenced ? innermost.start + 1 : innermost.start;
          const last = fenced ? first + newlinesIn(innermost.element) - 1 : innermost.end;

          if (line >= first && line <= last) {
            add(addedLines, innermost.element, line - first);
          }
        }
      }
    }

    if (run.kind === "removed") {
      const anchor = blocks.find(
        (block) => block.element.tagName !== "blockquote" && block.end >= run.at,
      );

      if (anchor === undefined) removedAtEnd.push(run);
      else if (anchor.element.tagName === "li") add(removedInside, anchor.element, run);
      else add(removedBefore, anchor.element, run);
    }
  }

  return { marked, addedLines, removedBefore, removedInside, removedAtEnd };
}
