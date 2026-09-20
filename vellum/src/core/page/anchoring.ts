import type { Passage } from "../protocol.ts";

const CONTEXT_CHARS = 32;

function offsetIn(container: Node, node: Node, offset: number): number {
  const range = document.createRange();
  range.selectNodeContents(container);
  range.setEnd(node, offset);

  return range.toString().length;
}

/**
 * A `data-lines` value, `start-end`, as its two source lines; `null` for anything else. The one
 * reader of the format a renderer writes on each block: `markdown/tree.ts` is its producer today.
 */
export function parseLines(value: string | undefined): readonly [number, number] | null {
  const [, start, end] = (value === undefined ? null : /^(\d+)-(\d+)$/u.exec(value)) ?? [];

  if (start === undefined || end === undefined) return null;

  // `parseInt` takes a string only, where `Number` takes an `undefined` and answers `NaN`.
  return [Number.parseInt(start, 10), Number.parseInt(end, 10)];
}

function linesOf(node: Node): readonly [number, number] | null {
  const element = node instanceof Element ? node : node.parentElement;

  return parseLines(element?.closest<HTMLElement>("[data-lines]")?.dataset.lines);
}

/** The selection inside `container`, as a passage; `null` when empty or outside. */
export function passageFromSelection(container: Element): Passage | null {
  const selection = document.getSelection();

  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return null;

  return passageFromRange(container, selection.getRangeAt(0));
}

/** `range` inside `container`, as a quote with its context and source lines; `null` when empty or outside. */
export function passageFromRange(container: Element, range: Range): Passage | null {
  if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) {
    return null;
  }

  const quote = range.toString();

  if (quote.trim() === "") return null;
  const text = container.textContent ?? "";
  const start = offsetIn(container, range.startContainer, range.startOffset);
  const startLines = linesOf(range.startContainer);
  const endLines = linesOf(range.endContainer);

  return {
    quote,
    prefix: text.slice(Math.max(0, start - CONTEXT_CHARS), start),
    suffix: text.slice(start + quote.length, start + quote.length + CONTEXT_CHARS),
    lines: [startLines?.[0] ?? 0, endLines?.[1] ?? startLines?.[1] ?? 0],
  };
}

function bestOffset(text: string, passage: Passage): number | null {
  let best: { offset: number; score: number } | null = null;

  for (let at = text.indexOf(passage.quote); at !== -1; at = text.indexOf(passage.quote, at + 1)) {
    const before = text.slice(Math.max(0, at - CONTEXT_CHARS), at);
    const after = text.slice(at + passage.quote.length, at + passage.quote.length + CONTEXT_CHARS);
    const score = commonSuffix(before, passage.prefix) + commonPrefix(after, passage.suffix);

    if (best === null || score > best.score) best = { offset: at, score };
  }

  return best?.offset ?? null;
}

function commonPrefix(a: string, b: string): number {
  let n = 0;

  while (n < a.length && n < b.length && a[n] === b[n]) n += 1;

  return n;
}

function commonSuffix(a: string, b: string): number {
  let n = 0;

  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n += 1;

  return n;
}

function positionAt(container: Node, target: number): [Node, number] | null {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let seen = 0;

  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;

    if (seen + length >= target) return [node, target - seen];
    seen += length;
  }

  return null;
}

/** Re-finds the quote in `container`, preferring the occurrence whose context matches. */
export function rangeFor(container: Element, passage: Passage): Range | null {
  const text = container.textContent ?? "";
  const offset = bestOffset(text, passage);

  if (offset === null) return null;
  const start = positionAt(container, offset);
  const end = positionAt(container, offset + passage.quote.length);

  if (start === null || end === null) return null;
  const range = document.createRange();
  range.setStart(start[0], start[1]);
  range.setEnd(end[0], end[1]);

  return range;
}
