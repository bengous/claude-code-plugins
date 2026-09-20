import type { Element, Root } from "hast";

import { parseLines } from "../../core/page/anchoring.ts";
import type { DiffRun, LineDiff } from "../../core/protocol.ts";

/**
 * What "Changes since" draws over the rendered plan: which blocks carry the green bar, and
 * where each removed run shows its old source. Pure, over the hast of `tree.ts`.
 */

export type RemovedRun = Extract<DiffRun, { readonly kind: "removed" }>;

/**
 * A removed run is drawn before the block that follows it, with two exceptions a `details`
 * forces: no child of a table body, it goes before the whole table; no child of a list, it
 * goes inside the item, as its first child.
 */
export type Changes = {
  readonly marked: ReadonlySet<Element>;
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
  readonly table: Element | null;
};

/** The blocks under `node` in document order, each with its own `data-lines`: an `li` stops before its nested list. */
function blocksOf(node: Root | Element, parent: Block | null, table: Element | null): Block[] {
  return node.children.flatMap((child) => {
    if (child.type !== "element") return [];
    const lines = parseLines(String(child.properties.dataLines));
    const within = child.tagName === "table" ? child : table;

    if (lines === null || !BLOCK_TAGS.has(child.tagName)) return blocksOf(child, null, within);
    const [start, end] = lines;

    const item =
      child.tagName === "p" &&
      parent?.element.tagName === "li" &&
      parent.start === start &&
      parent.end === end
        ? parent.element
        : null;

    const block = { element: child, start, end, marks: item ?? child, table: within };

    return [block, ...blocksOf(child, block, within)];
  });
}

function add(to: Map<Element, RemovedRun[]>, anchor: Element, run: RemovedRun): void {
  to.set(anchor, [...(to.get(anchor) ?? []), run]);
}

export function changesOf(tree: Root, diff: LineDiff): Changes {
  const blocks = blocksOf(tree, null, null);
  const marked = new Set<Element>();
  const removedBefore = new Map<Element, RemovedRun[]>();
  const removedInside = new Map<Element, RemovedRun[]>();
  const removedAtEnd: RemovedRun[] = [];

  for (const run of diff) {
    if (run.kind === "added") {
      for (let line = run.after; line < run.after + run.count; line += 1) {
        const innermost = blocks.findLast((block) => block.start <= line && line <= block.end);

        if (innermost !== undefined) marked.add(innermost.marks);
      }
    }

    if (run.kind === "removed") {
      const anchor = blocks.find(
        (block) => block.element.tagName !== "blockquote" && block.end >= run.at,
      );

      if (anchor === undefined) removedAtEnd.push(run);
      else if (anchor.element.tagName === "li") add(removedInside, anchor.element, run);
      else add(removedBefore, anchor.table ?? anchor.element, run);
    }
  }

  return { marked, removedBefore, removedInside, removedAtEnd };
}
