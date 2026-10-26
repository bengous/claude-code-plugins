import type { Stats } from "node:fs";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, sep } from "node:path";

// The files a map's citations name, under the folder the Config's `sources` names: check counts
// their lines, and serve.ts answers them to the page (server/source.ts). Node only. A citation
// names a file as the repository lists it, from that folder down: no absolute path, no `..`, and
// no link that leads out of the folder. Every filesystem error is a refusal, never a throw.

/**
 * Why a path gives no text: root, the folder is missing; outside, the path leads out of it, or
 * named another file once the file was open; missing, no regular file there; unreadable, the
 * filesystem refused it; large, over the bytes the reader takes; binary, a NUL byte.
 */
export type Unread = "root" | "outside" | "missing" | "unreadable" | "large" | "binary";

export type Refused = { readonly kind: "refused"; readonly why: Unread; readonly reason: string };

export type SourceFile = { readonly kind: "file"; readonly file: string } | Refused;

const refused = (why: Unread, reason: string): Refused => ({ kind: "refused", why, reason });

// Whatever stops a path from resolving, a missing entry or a loop of links among them, leaves it
// naming no file.
function realOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function statOrNull(path: string): Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

/** The real path of the file `path` names under the folder `root`, or why it names none. */
export function sourceFile(root: string, path: string): SourceFile {
  const top = realOrNull(root);

  if (top === null || statOrNull(top)?.isDirectory() !== true) {
    return refused("root", `the sources root ${root} is not a folder`);
  }

  if (isAbsolute(path) || path.split(/[/\\]/u).includes("..")) {
    return refused("outside", `${path} is no path from the sources root down`);
  }

  const real = realOrNull(join(top, path));

  if (real !== null && !real.startsWith(`${top}${sep}`)) {
    return refused("outside", `${path} leads out of the sources root ${root}`);
  }

  if (real === null || statOrNull(real)?.isFile() !== true) {
    return refused("missing", `no file ${path} under the sources root ${root}`);
  }

  return { kind: "file", file: real };
}

/** A text's lines, without their ends; a last line without its newline counts as one. */
export function textLines(text: string): string[] {
  const lines = text.split(/\r?\n/u);

  return lines.at(-1) === "" ? lines.slice(0, -1) : lines;
}

/** The largest file the page is answered, in bytes. */
export const SOURCE_CAP_BYTES = 1024 * 1024;

export type SourceText = { readonly kind: "text"; readonly lines: readonly string[] } | Refused;

// Bytes that are not UTF-8 read as U+FFFD: a file in another encoding still has its lines.
const UTF8 = new TextDecoder("utf-8");

// A link as the last part of the path fails the open, a FIFO or a device opens without waiting
// for a writer, and the descriptor is the one file read from then on: nothing reopens the path.
const OPEN = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

// At most `size` bytes, from the start of the file.
function head(fd: number, size: number): Uint8Array {
  const buffer = new Uint8Array(size);
  let length = 0;

  while (length < size) {
    const read = readSync(fd, buffer, length, size - length, length);

    if (read === 0) {
      break;
    }

    length += read;
  }

  return buffer.subarray(0, length);
}

function textOfOpen(root: string, path: string, fd: number, cap: number): SourceText {
  const opened = fstatSync(fd);

  if (!opened.isFile()) {
    return refused("missing", `no file ${path} under the sources root ${root}`);
  }

  // The path resolved again names the file opened: a swap of the file, or of a folder on its way,
  // between the check and the open is refused. A folder flipped to a link out and back between
  // the open, the realpath and the lstat would pass: accepted, as a writer inside the user's
  // repository already runs code through map.ts or its git hooks.
  const again = sourceFile(root, path);

  if (again.kind === "refused") {
    return again;
  }

  const named = lstatSync(again.file);

  if (named.dev !== opened.dev || named.ino !== opened.ino) {
    return refused("outside", `${path} named another file while it was opened`);
  }

  const large = refused("large", `${path} is over ${cap} bytes`);

  if (opened.size > cap) {
    return large;
  }

  const bytes = head(fd, Math.min(cap, opened.size) + 1);

  if (bytes.length > cap) {
    return large;
  }

  return bytes.includes(0)
    ? refused("binary", `${path} is a binary file: it holds a NUL byte`)
    : { kind: "text", lines: textLines(UTF8.decode(bytes)) };
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- it reads what a catch clause caught, which TypeScript types unknown: a filesystem call can throw anything.
const unreadable = (path: string, error: unknown): Refused =>
  refused(
    "unreadable",
    `${path} cannot be read: ${error instanceof Error ? error.message : String(error)}`,
  );

/**
 * The lines of `file`, the real path sourceFile found for `path` under `root`, read through one
 * descriptor: a file with no NUL byte, of at most `cap` bytes, that `path` still names, or why
 * not.
 */
export function sourceTextAt(
  root: string,
  path: string,
  file: string,
  cap = SOURCE_CAP_BYTES,
): SourceText {
  let fd: number;

  try {
    fd = openSync(file, OPEN);
  } catch (error: unknown) {
    return unreadable(path, error);
  }

  try {
    return textOfOpen(root, path, fd, cap);
  } catch (error: unknown) {
    return unreadable(path, error);
  } finally {
    closeSync(fd);
  }
}

/** The lines of the file `path` names under `root`, of at most `cap` bytes, or why not. */
export function sourceText(root: string, path: string, cap = SOURCE_CAP_BYTES): SourceText {
  const found = sourceFile(root, path);

  return found.kind === "refused" ? found : sourceTextAt(root, path, found.file, cap);
}
