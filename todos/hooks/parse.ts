import type { Todo } from "../types/index.d.ts";

export const DEFAULT_MARKERS: readonly string[] = ["TODO", "FIXME", "HACK"];

export const LIST_FILE = "TODO.md";

/** Prose and data files: a marker there is text about TODOs, or a transcript quoting one, never a comment. */
export const SKIPPED_EXTENSIONS: readonly string[] = [
  "md",
  "mdx",
  "markdown",
  "txt",
  "rst",
  "adoc",
  "json",
  "jsonl",
  "ndjson",
  "csv",
  "tsv",
  "lock",
  "svg",
  "log",
  "map",
];

export type CommentTodo = {
  readonly marker: string;
  readonly tag: string | null;
  readonly text: string;
};

export type GrepHit = CommentTodo & { readonly path: string; readonly line: number };

export type ListItem = { readonly line: number; readonly text: string };

export type Origin = {
  readonly commit: string | null;
  readonly authoredAt: number;
  readonly authorEmail: string | null;
};

const DAY_MS = 86_400_000;

const UNCOMMITTED_SHA = /^0{40}$/u;

const BLAME_HEADER = /^([0-9a-f]{40}) \d+ (\d+)/u;

const LIST_ITEM = /^[-*] (?:\[ \] )?(.*)$/u;

const DONE_ITEM = /^[-*] \[[xX]\] /u;

const COMMENT_CLOSER = /\s*(?:\*\/|-->)\s*$/u;

const escapeRegExp = (text: string): string =>
  text.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

/**
 * A marker counts only as the first word of a comment: after `//`, `/*`, `#`, `--`, `<!--` or `;`
 * that starts the line or follows a space, or after the `*` that continues a block comment.
 */
export function commentPattern(markers: readonly string[]): RegExp {
  const alternatives = markers.map((marker) => escapeRegExp(marker)).join("|");

  return new RegExp(
    String.raw`(?:^\s*\*+|(?:^|[\s({[])(?:\/\/+|\/\*+|#+|--+|<!--|;+))[\s!]*(${alternatives})\b(?:\(([^)]*)\))?:?\s*(.*)$`,
    "u",
  );
}

export function commentTodo(text: string, pattern: RegExp): CommentTodo | null {
  const match = pattern.exec(text);
  const marker = match?.[1];

  if (match === null || marker === undefined) return null;
  const tag = match[2]?.trim() ?? "";

  return {
    marker,
    tag: tag === "" ? null : tag,
    text: (match[3] ?? "").replace(COMMENT_CLOSER, "").trim(),
  };
}

/** `git grep -z -n` rows: path, NUL, line number, NUL, the line's text. */
export function parseGrep(stdout: string, markers: readonly string[]): GrepHit[] {
  const pattern = commentPattern(markers);

  return stdout.split("\n").flatMap((row) => {
    const [path, line, text] = row.split("\0");

    if (path === undefined || line === undefined || text === undefined) return [];
    const found = commentTodo(text, pattern);

    return found === null ? [] : [{ ...found, path, line: Number(line) }];
  });
}

/** Top-level `- ` or `* ` items, unchecked boxes included and checked ones left out; the title stops at its first `:` or `;` past ten characters. */
export function parseList(text: string): ListItem[] {
  return text.split("\n").flatMap((row, index) => {
    if (DONE_ITEM.test(row)) return [];
    const body = LIST_ITEM.exec(row)?.[1]?.replaceAll("`", "").trim();

    if (body === undefined || body === "") return [];
    const cut = body.search(/[:;]/u);

    return [{ line: index + 1, text: cut > 10 ? body.slice(0, cut) : body }];
  });
}

/** `git blame --line-porcelain` output, keyed by the line's number in the working tree. */
export function parseBlame(porcelain: string): Map<number, Origin> {
  const origins = new Map<number, Origin>();
  let sha = "";
  let finalLine = 0;
  let authoredAt = 0;
  let authorEmail = "";

  for (const row of porcelain.split("\n")) {
    const header = BLAME_HEADER.exec(row);

    if (header !== null) {
      sha = header[1] ?? "";
      finalLine = Number(header[2]);
    } else if (row.startsWith("author-mail ")) {
      authorEmail = row.slice("author-mail ".length).replaceAll(/^<|>$/gu, "");
    } else if (row.startsWith("author-time ")) {
      authoredAt = Number(row.slice("author-time ".length)) * 1000;
    } else if (row.startsWith("\t")) {
      const isUncommitted = UNCOMMITTED_SHA.test(sha);
      origins.set(finalLine, {
        commit: isUncommitted ? null : sha.slice(0, 8),
        authoredAt,
        authorEmail: isUncommitted ? null : authorEmail,
      });
    }
  }

  return origins;
}

const sourceRank = (todo: Todo): number => (todo.source === "list" ? 0 : 1);

export function sortNewestFirst(todos: readonly Todo[]): Todo[] {
  return todos.toSorted(
    (a, b) =>
      b.authoredAt - a.authoredAt ||
      sourceRank(a) - sourceRank(b) ||
      a.path.localeCompare(b.path) ||
      a.line - b.line,
  );
}

export function formatAge(ms: number): string {
  const days = Math.floor(ms / DAY_MS);

  if (days < 1) return "today";

  if (days < 14) return `${days}d`;

  if (days < 60) return `${Math.floor(days / 7)}w`;

  if (days < 365) return `${Math.floor(days / 30)}mo`;

  return `${Math.floor(days / 365)}y`;
}

export function sourceLabel(todo: Todo): string {
  return todo.source === "list" ? todo.path : `${todo.path}:${todo.line}`;
}

/** Keeps the end of a path, where the file name and line are. */
export function shortenStart(text: string, width: number): string {
  return text.length <= width ? text : `…${text.slice(text.length - width + 1)}`;
}

export function displayText(todo: Todo): string {
  const text = todo.text === "" ? "(no description)" : todo.text;

  return todo.source === "comment" && todo.marker !== "TODO" ? `${todo.marker} ${text}` : text;
}
