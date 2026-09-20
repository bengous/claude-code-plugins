/** Where the editor opens: the source line of the block the reviewer was reading, as a caret offset. */

import { parseLines } from "./anchoring.ts";

/** The offset of the first character of the 1-based `line` of `text`; the end of the text for a line past it. */
export function offsetOfLine(text: string, line: number): number {
  let offset = 0;

  for (let at = 1; at < line; at += 1) {
    const next = text.indexOf("\n", offset);

    if (next === -1) return text.length;
    offset = next + 1;
  }

  return offset;
}

/**
 * The first source line of the first element of the plan whose top is inside `panes`; of the
 * last element when the pane is scrolled below every top.
 */
export function lineAtTop(panes: Element): number {
  const { top } = panes.getBoundingClientRect();
  let line = 1;

  for (const element of panes.querySelectorAll<HTMLElement>(".plan [data-lines]")) {
    line = parseLines(element.dataset.lines)?.[0] ?? line;

    if (element.getBoundingClientRect().top >= top) return line;
  }

  return line;
}
