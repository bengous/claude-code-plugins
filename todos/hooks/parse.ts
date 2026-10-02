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

const NEVER = /(?!)/u;

const ISSUE_TAG = /^#(\d+)$/u;

const GITHUB_REMOTE =
  /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/u;

const escapeRegExp = (text: string): string =>
  text.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

/**
 * A marker counts only as the first word of a comment: after `//`, `/*`, `#`, `--`, `<!--` or `;`
 * that starts the line or follows a space, or after the `*` that continues a block comment.
 */
export function commentPattern(markers: readonly string[]): RegExp {
  if (markers.length === 0) return NEVER;
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

/** The markers setting: words separated by commas or spaces, each kept once. */
export function parseMarkers(setting: string): string[] {
  return [...new Set(setting.split(/[\s,]+/u).filter((word) => word !== ""))];
}

/** The web address of a GitHub remote, where `TODO(#42)` links to; null for any other host. */
export function githubWebUrl(remote: string): string | null {
  const slug = GITHUB_REMOTE.exec(remote.trim())?.[1];

  return slug === undefined ? null : `https://github.com/${slug}`;
}

export function issueNumber(tag: string | null): number | null {
  const digits = tag === null ? undefined : ISSUE_TAG.exec(tag)?.[1];

  return digits === undefined ? null : Number(digits);
}

/** An uncommitted line is the person's own work. */
export function isMine(todo: Todo, email: string | null): boolean {
  if (todo.authorEmail === null) return true;

  return email !== null && todo.authorEmail.toLowerCase() === email.toLowerCase();
}

/** Whether a scan reads this repository-relative path: TODO.md, or a file outside the skipped extensions. */
export function isScannedPath(path: string): boolean {
  if (path === LIST_FILE) return true;
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");

  return dot <= 0 || !SKIPPED_EXTENSIONS.includes(name.slice(dot + 1).toLowerCase());
}

export type AddedTodo = CommentTodo & { readonly line: number };

const todoKey = (todo: CommentTodo): string => `${todo.marker}\0${todo.text}`;

function todosOfText(path: string, text: string, pattern: RegExp): AddedTodo[] {
  if (path === LIST_FILE) {
    return parseList(text).map((item) => ({ ...item, marker: "TODO", tag: null }));
  }

  return text.split("\n").flatMap((row, index) => {
    const found = commentTodo(row, pattern);

    return found === null ? [] : [{ ...found, line: index + 1 }];
  });
}

/** The TODOs `after` holds and `before` did not, matched by marker and text so that a moved line is not new. */
export function addedTodos(
  path: string,
  before: string,
  after: string,
  markers: readonly string[],
): AddedTodo[] {
  const pattern = commentPattern(markers);
  const remaining = new Map<string, number>();

  for (const todo of todosOfText(path, before, pattern)) {
    remaining.set(todoKey(todo), (remaining.get(todoKey(todo)) ?? 0) + 1);
  }

  return todosOfText(path, after, pattern).filter((todo) => {
    const count = remaining.get(todoKey(todo)) ?? 0;

    if (count === 0) return true;
    remaining.set(todoKey(todo), count - 1);

    return false;
  });
}
