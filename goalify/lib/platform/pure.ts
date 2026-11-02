/** `value` as one POSIX shell word: always single-quoted, each `'` written `'\''`. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** A mod's `$.fs` rejects with no `code` and ends its message on the errno: `… failed: ENOENT`. */
const MOD_ERRNO = / failed: (E[A-Z0-9]+)$/u;

/** The errno a thrown value carries: its `code`, else the one a mod's message ends on; `null` when neither. */
export function errnoOf(cause: unknown): string | null {
  if (!(cause instanceof Error)) return null;

  if ("code" in cause && cause.code !== undefined && cause.code !== null) return String(cause.code);

  return MOD_ERRNO.exec(cause.message)?.[1] ?? null;
}

/** Whether the thrown value's errno (`errnoOf`) is one of `codes`. */
export function isErrno(cause: unknown, ...codes: readonly string[]): boolean {
  const errno = errnoOf(cause);

  return errno !== null && codes.includes(errno);
}

export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const DRIVE = /^[A-Za-z]:/u;

/** Absolute under these separators: led by one, or, when `\` is one, a drive letter followed by one. */
function isAbsoluteWith(path: string, seps: readonly string[]): boolean {
  if (seps.some((sep) => path.startsWith(sep))) return true;

  return seps.includes("\\") && DRIVE.test(path) && seps.some((sep) => path.startsWith(sep, 2));
}

function segmentsOf(path: string, seps: readonly string[]): string[] {
  return seps.reduce<string[]>((parts, sep) => parts.flatMap((part) => part.split(sep)), [path]);
}

/**
 * Whether a relative path, such as `path.relative(root, file)` answers, stays under its root: `""`
 * (the root itself) and `..env` do; a whole `..` segment or an absolute path does not. `seps` are
 * the separators the path uses, passed explicitly since on POSIX `\` is part of a name: `[sep]` for
 * `node:path`'s answer, `["/", "\\"]` for a path that may hold either.
 */
export function isInsideRelative(rel: string, seps: readonly string[]): boolean {
  return !isAbsoluteWith(rel, seps) && !segmentsOf(rel, seps).includes("..");
}

/**
 * Whether `path` lies under `root`, lexically: past a separator boundary (`/a` holds `/a/b`, not
 * `/ab`), with no `..` segment anywhere in `path`. The root itself is not under itself: a caller
 * that counts it adds `path === root`.
 */
export function isUnder(root: string, path: string, sep: string): boolean {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;

  return path.startsWith(prefix) && path.length > prefix.length && !path.split(sep).includes("..");
}

function lastSeparator(path: string): number {
  return Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
}

/** What follows the last `/` or `\`; the whole path when it holds neither. */
export function baseNameOf(path: string): string {
  return path.slice(lastSeparator(path) + 1);
}

/** What precedes the last `/` or `\`, `/` when that separator leads the path; `null` when it holds neither. */
export function dirNameOf(path: string): string | null {
  const slash = lastSeparator(path);

  return slash < 0 ? null : path.slice(0, slash) || "/";
}
