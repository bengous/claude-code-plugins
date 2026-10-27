import { existsSync } from "node:fs";
import path from "node:path";

import type { Argv } from "./exec.ts";

export type Placeholders = {
  readonly root: string;
  readonly pkg: string;
  readonly file?: string;
  readonly path?: string;
  readonly files?: readonly string[];
};

export type PathFilter = { readonly on: string; readonly exclude: readonly string[] };

/** Splits on whitespace outside single or double quotes; no shell runs, so no escapes or expansions. */
export function splitCommand(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let inWord = false;

  for (const char of command) {
    if (quote === null && (char === "'" || char === '"')) {
      quote = char;
      inWord = true;
    } else if (char === quote) {
      quote = null;
    } else if (quote === null && /\s/u.test(char)) {
      if (inWord) {
        words.push(current);
        current = "";
        inWord = false;
      }
    } else {
      current += char;
      inWord = true;
    }
  }

  if (inWord) {
    words.push(current);
  }

  return words;
}

/** The argv of a command with its placeholders filled; `{files}` yields one argument per file. */
export function expandCommand(command: string, vars: Placeholders): Argv | null {
  const words = splitCommand(command).flatMap((word): readonly string[] => {
    if (word === "{files}") {
      return vars.files ?? [];
    }

    return [
      word
        .replaceAll("{root}", vars.root)
        .replaceAll("{pkg}", vars.pkg)
        .replaceAll("{file}", vars.file ?? "")
        .replaceAll("{path}", vars.path ?? ""),
    ];
  });

  const [program, ...args] = words;

  return program === undefined ? null : [program, ...args];
}

/** The nearest ancestor of `relativePath` under `root` that holds a package.json or a Cargo.toml, else the root. */
export function pkgOf(root: string, relativePath: string): string {
  let dir = path.dirname(path.resolve(root, relativePath));
  const stop = path.resolve(root);

  while (dir.startsWith(stop)) {
    if (existsSync(path.join(dir, "package.json")) || existsSync(path.join(dir, "Cargo.toml"))) {
      return dir;
    }

    if (dir === stop) {
      break;
    }

    dir = path.dirname(dir);
  }

  return stop;
}

export function matchesFilter(filter: PathFilter, relativePath: string): boolean {
  return new Bun.Glob(filter.on).match(relativePath) && !isExcluded(filter.exclude, relativePath);
}

export function isExcluded(exclude: readonly string[], relativePath: string): boolean {
  return exclude.some((pattern) => new Bun.Glob(pattern).match(relativePath));
}
