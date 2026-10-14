export const PLUGIN = "secret-pane";

const TAG_SOURCE = String.raw`\[secret-pane:[A-Za-z_][A-Za-z0-9_]*:[0-9a-f]{8}\]`;

export const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** The shortest value kept: shorter ones would hide ordinary words wherever they turn up. */
export const MIN_VALUE_LENGTH = 8;

const WALK_DEPTH = 32;

export type Vault = {
  /** The placeholder standing for a value, minted on the first ask and stable after. */
  readonly tagOf: (name: string, value: string, seed: number) => string;
  /** The value behind a placeholder, or nothing for one this vault never minted. */
  readonly valueOf: (tag: string) => string | undefined;
  /** The text with every kept value replaced by its placeholder, in one pass. */
  readonly hide: (text: string) => string;
  readonly isEmpty: () => boolean;
  readonly clear: () => void;
};

function hex8(seed: number, salt: string): string {
  let hash = 0x811c9dc5 ^ (seed >>> 0);

  for (const char of `${seed}:${salt}`) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash.toString(16).padStart(8, "0");
}

function escaped(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

export function createVault(): Vault {
  const tagByValue = new Map<string, string>();
  const valueByTag = new Map<string, string>();
  let minted = 0;
  let pattern: RegExp | null = null;

  // One alternation, placeholders first so a value found inside one is never rewritten, then the
  // values longest first so a value inside a longer one does not split it.
  const matcher = (): RegExp => {
    pattern ??= new RegExp(
      [
        TAG_SOURCE,
        ...[...tagByValue.keys()]
          .toSorted((a, b) => b.length - a.length)
          .map((value) => escaped(value)),
      ].join("|"),
      "gu",
    );

    return pattern;
  };

  return {
    tagOf: (name, value, seed) => {
      const known = tagByValue.get(value);

      if (known !== undefined) return known;
      let tag = "";

      do {
        minted += 1;
        tag = `[secret-pane:${name}:${hex8(seed + minted, `${name}:${minted}`)}]`;
      } while (valueByTag.has(tag));

      tagByValue.set(value, tag);
      valueByTag.set(tag, value);
      pattern = null;

      return tag;
    },
    valueOf: (tag) => valueByTag.get(tag),
    hide: (text) =>
      tagByValue.size === 0
        ? text
        : text.replace(matcher(), (found) => tagByValue.get(found) ?? found),
    isEmpty: () => tagByValue.size === 0,
    clear: () => {
      tagByValue.clear();
      valueByTag.clear();
      pattern = null;
    },
  };
}

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof -- a tool's record is the engine's `unknown`, whatever shape the tool gave it; this walk IS the boundary that reads it, and the caller keeps the engine's own type for the shape it hands back. */
/** Every string of a plain value rewritten, the shape kept; a value nested past the depth is left as it is. */
export function walkStrings(value: unknown, rewrite: (text: string) => string, depth = 0): unknown {
  if (typeof value === "string") return rewrite(value);

  if (depth >= WALK_DEPTH || value === null || typeof value !== "object") return value;

  if (Array.isArray(value)) return value.map((item) => walkStrings(item, rewrite, depth + 1));

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, walkStrings(item, rewrite, depth + 1)]),
  );
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof */

/**
 * The value a masked field holds after the person typed, or nothing when the
 * edit cannot be read. The field draws one dot per character held, so a change
 * at the end hands back the dots kept, then what was typed or pasted; a dot
 * after typed text is an edit in the middle, where the mod cannot tell which
 * characters moved.
 */
export function mergeTyped(held: string, drawn: string, dot: string): string | null {
  let kept = 0;

  while (kept < drawn.length && kept < held.length && drawn[kept] === dot) kept += 1;
  const typed = drawn.slice(kept);

  return typed.includes(dot) ? null : held.slice(0, kept) + typed;
}

export type Entered =
  | { readonly kind: "kept"; readonly value: string }
  | { readonly kind: "refused"; readonly why: string };

/** The value the box keeps on Enter, trimmed, or why it keeps none. */
export function entered(held: string): Entered {
  const value = held.trim();

  if (value === "")
    return { kind: "refused", why: "the field is empty: paste the value, or Esc to cancel" };

  if (value.length < MIN_VALUE_LENGTH) {
    return {
      kind: "refused",
      why: `at least ${MIN_VALUE_LENGTH} characters: a shorter value cannot be hidden wherever it turns up`,
    };
  }

  return { kind: "kept", value };
}
