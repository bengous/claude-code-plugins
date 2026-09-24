import {
  bestOffset,
  commonPrefix,
  commonSuffix,
  CONTEXT_CHARS,
} from "../../core/page/anchoring.ts";
import type { WordsContext } from "../../core/protocol.ts";

/**
 * Words dragged in a mockup's element, placed by their context and found again whatever the
 * whitespace became. `raw` is the element's text as its text nodes hold it; every offset is in it.
 */

/** A click picks the whole element: no words to place. */
export const CLICK_CONTEXT: WordsContext = { prefix: "", suffix: "", repeated: false };

/**
 * A click quotes this much of its element, which may hold a whole page, and an element's name
 * and heading are cut there too. A drag quotes its whole text: the reviewer chose each word of it.
 */
export const TEXT_LIMIT = 120;

/** What a comment quotes of `text`: every run of whitespace one space, none at the ends. */
export function quoted(text: string): string {
  return text.replaceAll(/\s+/gu, " ").trim();
}

/** A text with every run of whitespace one space, and the offset in the raw text of each of its characters. */
type Collapsed = { readonly text: string; readonly from: readonly number[] };

function collapsed(raw: string): Collapsed {
  const from: number[] = [];
  let text = "";
  let inRun = false;

  for (let at = 0; at < raw.length; at += 1) {
    const char = raw.charAt(at);
    const space = /\s/u.test(char);

    if (!space || !inRun) {
      text += space ? " " : char;
      from.push(at);
    }

    inRun = space;
  }

  return { text, from };
}

/** The context of the words dragged from `start` to `end` of `raw`. */
export function contextOf(raw: string, start: number, end: number): WordsContext {
  const { text, from } = collapsed(raw);
  const quote = quoted(raw.slice(start, end));
  const after = from.findIndex((offset) => offset >= start);
  const at = text.indexOf(quote, after === -1 ? from.length : after);

  return {
    prefix: text.slice(Math.max(0, at - CONTEXT_CHARS), at).trimStart(),
    suffix: text.slice(at + quote.length, at + quote.length + CONTEXT_CHARS).trimEnd(),
    repeated: text.indexOf(quote) !== at || text.includes(quote, at + 1),
  };
}

/** A word or a number: what a context shares with an occurrence before it counts, a space or a stop being in every one. */
const WORDY = /[\p{L}\p{N}]/u;

/** Whether the occurrence of `words` at `at` in `text` shares a word of its context, on either side. */
function sharesContext(text: string, at: number, words: string, context: WordsContext): boolean {
  const before = text.slice(Math.max(0, at - CONTEXT_CHARS), at);
  const after = text.slice(at + words.length, at + words.length + CONTEXT_CHARS);

  const shared = [
    before.slice(before.length - commonSuffix(before, context.prefix)),
    after.slice(0, commonPrefix(after, context.suffix)),
  ];

  return shared.some((side) => WORDY.test(side));
}

/**
 * Where `words` sit in `raw`, the occurrence whose context fits best; `null` once they are gone,
 * and when the one that fits best shares no word of a context that was kept: the same words
 * elsewhere in the element are not the ones dragged.
 */
export function wordsIn(
  raw: string,
  words: string,
  context: WordsContext,
): readonly [number, number] | null {
  const { text, from } = collapsed(raw);
  const found = bestOffset(text, { quote: words, prefix: context.prefix, suffix: context.suffix });
  const kept = context.prefix !== "" || context.suffix !== "";
  const at = found !== null && kept && !sharesContext(text, found, words, context) ? null : found;
  const first = at === null ? undefined : from[at];
  const last = at === null ? undefined : from[at + words.length - 1];

  return first === undefined || last === undefined ? null : [first, last + 1];
}
