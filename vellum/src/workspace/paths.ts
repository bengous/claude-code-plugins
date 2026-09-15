export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

declare const brand: unique symbol;

type Branded<T, Name extends string> = T & { readonly [brand]: Name };

/** `plans/<date>/wip-<sid8>/`, relative to the project root, trailing slash kept. */
export type WipDir = Branded<string, "WipDir">;

/** `plans/<date>/<slug>/`, relative to the project root, trailing slash kept. */
export type FinalDir = Branded<string, "FinalDir">;

/** Integer, 1 or more. */
export type Version = Branded<number, "Version">;

export type Slug = Branded<string, "Slug">;

/** Relative to the project root, never climbing out of it. */
export type ProjectPath = Branded<string, "ProjectPath">;

const WIP_DIR = /^plans\/(\d{4}-\d{2}-\d{2})\/wip-[0-9a-f]{8}\/$/u;

const FINAL_DIR = /^plans\/(\d{4}-\d{2}-\d{2})\/(?!wip-)[a-z0-9][a-z0-9-]*\/$/u;

export function parseWipDir(path: string): ParseResult<WipDir> {
  // SAFETY: the brand is granted by the regex match on the line below.
  return WIP_DIR.test(path)
    ? { ok: true, value: path as WipDir }
    : { ok: false, error: `not a working directory (plans/<date>/wip-<sid8>/): ${path}` };
}

export function parseFinalDir(path: string): ParseResult<FinalDir> {
  // SAFETY: the brand is granted by the regex match on the line below.
  return FINAL_DIR.test(path)
    ? { ok: true, value: path as FinalDir }
    : { ok: false, error: `not a final plan directory (plans/<date>/<slug>/): ${path}` };
}

export function dateOf(dir: WipDir | FinalDir): string {
  return dir.split("/")[1] ?? "";
}

export function parseVersion(value: number): ParseResult<Version> {
  // SAFETY: the brand is granted by the integer check on the line below.
  return Number.isInteger(value) && value >= 1
    ? { ok: true, value: value as Version }
    : { ok: false, error: `not a version (integer >= 1): ${value}` };
}

export function parseProjectPath(path: string): ParseResult<ProjectPath> {
  const segments = path.split("/");

  if (path === "" || path.startsWith("/") || path.includes("\\")) {
    return { ok: false, error: `not a project-relative path: ${path}` };
  }

  if (segments.some((segment) => segment === "..")) {
    return { ok: false, error: `path climbs out of the project: ${path}` };
  }

  // SAFETY: the checks above reject an absolute path and every `..` segment.
  return {
    ok: true,
    value: segments.filter((s) => s !== "." && s !== "").join("/") as ProjectPath,
  };
}
