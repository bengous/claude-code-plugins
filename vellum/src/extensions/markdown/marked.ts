import { BLOCK_TAGS } from "./changes.ts";

/** A rendered block as the DOM shows it: its tag and its `data-lines`. */
export type LinedBlock = { readonly tag: string; readonly lines: string };

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
    const match = /^(\d+)-(\d+)$/u.exec(lines);

    return match === null || !BLOCK_TAGS.has(tag)
      ? null
      : { start: Number(match[1]), end: Number(match[2]) };
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
