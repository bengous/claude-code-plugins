export const PLUGIN = "secret-pane";

const TAG = /\[secret-pane:([A-Za-z_][A-Za-z0-9_]*):([0-9a-f]{8})\]/gu;

export const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** A value shorter than this is left as printed: hiding it would hide ordinary words. */
const HIDDEN_MIN_LENGTH = 4;

/** A restored value goes into Bash as shell source: one holding any of these could run as code. */
const SHELL_ACTIVE = /[\s$`"'\\;&|<>()*?[\]{}#~]/u;

/** The git subcommands that write text into history or send it out, where a real value cannot be taken back. */
const GIT_WRITES = new Set([
  "commit",
  "tag",
  "notes",
  "send-email",
  "merge",
  "revert",
  "cherry-pick",
  "am",
  "stash",
  "rebase",
  "format-patch",
  "request-pull",
]);

/** The one gh subcommand that takes a value in order to keep it secret. */
const GH_SINK = "secret";

/** gh's global options that take the next word as their value. */
const GH_VALUED_OPTIONS = new Set(["-R", "--repo"]);

/** The first word after `gh` that is no option: its subcommand. */
function ghSubcommand(words: readonly string[]): string | undefined {
  for (let at = 0; at < words.length; at += 1) {
    const word = words[at] ?? "";

    if (!word.startsWith("-")) return word;

    if (GH_VALUED_OPTIONS.has(word)) at += 1;
  }

  return undefined;
}

/** Where one simple command ends and the next begins: a pipe, a list, a line. */
const SEGMENT = /\|\|?|&&|;|\n/u;

const WALK_DEPTH = 32;

export type Restored = { readonly text: string; readonly handed: readonly string[] };

export type Vault = {
  /** The placeholder standing for a value, minted on the first ask and stable after. */
  readonly tagOf: (name: string, value: string, seed: number) => string;
  /** The placeholder of a kept value, or nothing for a value never kept. */
  readonly tagFor: (value: string) => string | undefined;
  /** The text with each placeholder replaced by its value, and the values put in. */
  readonly restore: (text: string) => Restored;
  /** The text with each of the values replaced by its placeholder, longest first; every kept value when none is named. */
  readonly hide: (text: string, values?: readonly string[]) => string;
  readonly isEmpty: () => boolean;
};

function hex8(seed: number, salt: string): string {
  let hash = 0x811c9dc5 ^ (seed >>> 0);

  for (const char of `${seed}:${salt}`) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash.toString(16).padStart(8, "0");
}

export function createVault(): Vault {
  const tagByValue = new Map<string, string>();
  const valueByTag = new Map<string, string>();
  let minted = 0;

  const hide = (text: string, values: readonly string[] = [...tagByValue.keys()]): string => {
    let out = text;

    for (const value of values.toSorted((a, b) => b.length - a.length)) {
      const tag = tagByValue.get(value);

      if (tag !== undefined && value.length >= HIDDEN_MIN_LENGTH && out.includes(value)) {
        out = out.split(value).join(tag);
      }
    }

    return out;
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

      return tag;
    },
    restore: (text) => {
      const handed = new Set<string>();

      const restored = text.replace(TAG, (tag) => {
        const value = valueByTag.get(tag);

        if (value === undefined) return tag;
        handed.add(value);

        return value;
      });

      return { text: restored, handed: [...handed] };
    },
    tagFor: (value) => tagByValue.get(value),
    hide,
    isEmpty: () => tagByValue.size === 0,
  };
}

export function isShellActive(value: string): boolean {
  return SHELL_ACTIVE.test(value);
}

/**
 * Whether a command writes text into git history or sends it to GitHub, read
 * simple command by simple command from the words that follow `git` or `gh`:
 * any git subcommand of the list, wherever it stands after the options, and
 * every gh subcommand but the secret sink.
 */
export function publishes(command: string): boolean {
  return command.split(SEGMENT).some((segment) => {
    const words = segment.trim().split(/\s+/u);
    const git = words.indexOf("git");
    const gh = words.indexOf("gh");

    if (git >= 0 && words.slice(git + 1).some((word) => GIT_WRITES.has(word))) return true;

    return gh >= 0 && ghSubcommand(words.slice(gh + 1)) !== GH_SINK;
  });
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
 * The value a masked field holds after the person typed: the field draws one
 * dot per character held, so what the terminal hands back is the dots kept,
 * then what was typed or pasted; fewer dots than held is a deletion at the end.
 */
export function mergeTyped(held: string, drawn: string, dot: string): string {
  let kept = 0;

  while (kept < drawn.length && kept < held.length && drawn[kept] === dot) kept += 1;

  return held.slice(0, kept) + drawn.slice(kept);
}
