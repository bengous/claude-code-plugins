import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";

// The files a map's citations name, under the folder the Config's `sources` names: check counts
// their lines, and serve.ts answers them to the page (server/source.ts). Node only. A citation
// names a file as the repository lists it, from that folder down: no absolute path, no `..`, and
// no link that leads out of the folder.

export type SourceFile =
  | { readonly kind: "file"; readonly file: string }
  | {
      readonly kind: "refused";
      /** root: the folder is missing; outside: the path leads out of it; missing: no file there. */
      readonly why: "root" | "outside" | "missing";
      readonly reason: string;
    };

// Whatever stops a path from resolving, a missing entry or a loop of links among them, leaves it
// naming no file.
function realOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** The real path of the file `path` names under the folder `root`, or why it names none. */
export function sourceFile(root: string, path: string): SourceFile {
  const top = realOrNull(root);

  if (top === null || !statSync(top).isDirectory()) {
    return { kind: "refused", why: "root", reason: `the sources root ${root} is not a folder` };
  }

  if (isAbsolute(path) || path.split(/[/\\]/u).includes("..")) {
    return {
      kind: "refused",
      why: "outside",
      reason: `${path} is no path from the sources root down`,
    };
  }

  const real = realOrNull(join(top, path));

  if (real !== null && !real.startsWith(`${top}${sep}`)) {
    return {
      kind: "refused",
      why: "outside",
      reason: `${path} leads out of the sources root ${root}`,
    };
  }

  if (real === null || !statSync(real).isFile()) {
    return {
      kind: "refused",
      why: "missing",
      reason: `no file ${path} under the sources root ${root}`,
    };
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

export type SourceText =
  | { readonly kind: "text"; readonly lines: readonly string[] }
  | {
      readonly kind: "refused";
      /** sourceFile's, then large: over SOURCE_CAP_BYTES; binary: a NUL byte, or not UTF-8. */
      readonly why: "root" | "outside" | "missing" | "large" | "binary";
      readonly reason: string;
    };

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

/** The lines of the text file `path` names under `root`, at most SOURCE_CAP_BYTES, or why not. */
export function sourceText(root: string, path: string): SourceText {
  const source = sourceFile(root, path);

  if (source.kind === "refused") {
    return source;
  }

  if (statSync(source.file).size > SOURCE_CAP_BYTES) {
    return { kind: "refused", why: "large", reason: `${path} is over ${SOURCE_CAP_BYTES} bytes` };
  }

  const text = textOf(readFileSync(source.file));

  return text === null
    ? { kind: "refused", why: "binary", reason: `${path} is not a text file in UTF-8` }
    : { kind: "text", lines: textLines(text) };
}
