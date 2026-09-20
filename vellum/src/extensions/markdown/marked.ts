import { parseLines } from "../../core/page/anchoring.ts";
import { BLOCK_TAGS } from "./changes.ts";

/** A rendered block as the DOM shows it: its tag and its `data-lines`. */
export type LinedBlock = { readonly tag: string; readonly lines: string };

/** `BLOCK_TAGS` names the hast's blocks; the page draws the hast's mermaid `pre` as a `figure`. */
const DOM_BLOCK_TAGS: ReadonlySet<string> = new Set([...BLOCK_TAGS, "figure"]);

/**
 * Which blocks carry the margin fillet of a commented passage: for each line of `passages`, the
 * innermost block holding it. `blocks` is in document order, so an outer block comes before the
 * blocks it holds and the last match is the innermost. Pure; `page.tsx` toggles the class.
 */
export function markedIndices(
  blocks: readonly LinedBlock[],
  passages: readonly (readonly [number, number])[],
): ReadonlySet<number> {
  const spans = blocks.map(({ tag, lines }) => {
    const parsed = parseLines(lines);

    return parsed === null || !DOM_BLOCK_TAGS.has(tag)
      ? null
      : { start: parsed[0], end: parsed[1] };
  });

  const marked = new Set<number>();

  for (const [from, to] of passages) {
    for (let line = from; line <= to; line += 1) {
      const innermost = spans.findLastIndex(
        (span) => span !== null && span.start <= line && line <= span.end,
      );

      if (innermost !== -1) marked.add(innermost);
    }
  }

  return marked;
}
