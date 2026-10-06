/** A Claude Code version or a GitHub Actions run id, at `index` in the text it was found in. */
export interface FrozenFact {
  index: number;
  text: string;
}

const FROZEN_FACT_PATTERNS = [
  // Every Claude Code release the repo cites has a patch of three digits or
  // more; no other tool's or plugin's version does. A fourth component makes
  // it some other product's build number. Named, any patch is Claude Code's.
  /(?<=(?:^|[^\w.])v?)\d+\.\d+\.\d{3,}(?!\.?\d)/gu,
  /(?<=\bclaude[ -]code(?:@|\s+)v?)\d+\.\d+\.\d+(?!\.?\d)/giu,
  // An Actions run id has 11 digits until GitHub's counter passes 10^11,
  // where a Unix time has 10 in seconds and 13 in milliseconds. No context
  // word: the docs also cite a run as "ran in <id>" or "In <id>".
  /(?<![\w.])\d{11}(?!\w|\.\d)/gu,
] as const;

export function frozenFactsIn(text: string): FrozenFact[] {
  const found = new Map<number, string>();

  for (const pattern of FROZEN_FACT_PATTERNS) {
    for (const match of text.matchAll(pattern)) found.set(match.index, match[0]);
  }

  return [...found]
    .toSorted(([left], [right]) => left - right)
    .map(([index, fact]) => ({ index, text: fact }));
}
