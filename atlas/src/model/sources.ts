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
 * filesystem refused it; large, over SOURCE_CAP_BYTES; binary, a NUL byte or not UTF-8.
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

const UTF8 = new TextDecoder("utf-8", { fatal: true });

function textOf(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) {
    return null;
  }

  try {
    return UTF8.decode(bytes);
  } catch {
    return null;
  }
}

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

function textOfOpen(root: string, path: string, fd: number): SourceText {
  const opened = fstatSync(fd);

  if (!opened.isFile()) {
    return refused("missing", `no file ${path} under the sources root ${root}`);
  }

  // The path resolved again names the file opened: a swap of the file, or of a folder on its way,
  // between the check and the open is refused.
  const again = sourceFile(root, path);

  if (again.kind === "refused") {
    return again;
  }

  const named = lstatSync(again.file);

  if (named.dev !== opened.dev || named.ino !== opened.ino) {
    return refused("outside", `${path} named another file while it was opened`);
  }

  const large = refused("large", `${path} is over ${SOURCE_CAP_BYTES} bytes`);

  if (opened.size > SOURCE_CAP_BYTES) {
    return large;
  }

  const bytes = head(fd, SOURCE_CAP_BYTES + 1);

  if (bytes.length > SOURCE_CAP_BYTES) {
    return large;
  }

  const text = textOf(bytes);

  return text === null
    ? refused("binary", `${path} is not a text file in UTF-8`)
    : { kind: "text", lines: textLines(text) };
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- it reads what a catch clause caught, which TypeScript types unknown: a filesystem call can throw anything.
const unreadable = (path: string, error: unknown): Refused =>
  refused(
    "unreadable",
    `${path} cannot be read: ${error instanceof Error ? error.message : String(error)}`,
  );

/**
 * The lines of `file`, the real path sourceFile found for `path` under `root`, read through one
 * descriptor: a text file of at most SOURCE_CAP_BYTES that `path` still names, or why not.
 */
export function sourceTextAt(root: string, path: string, file: string): SourceText {
  let fd: number;

  try {
    fd = openSync(file, OPEN);
  } catch (error: unknown) {
    return unreadable(path, error);
  }

  try {
    return textOfOpen(root, path, fd);
  } catch (error: unknown) {
    return unreadable(path, error);
  } finally {
    closeSync(fd);
  }
}

/** The lines of the text file `path` names under `root`, at most SOURCE_CAP_BYTES, or why not. */
export function sourceText(root: string, path: string): SourceText {
  const found = sourceFile(root, path);

  return found.kind === "refused" ? found : sourceTextAt(root, path, found.file);
}
