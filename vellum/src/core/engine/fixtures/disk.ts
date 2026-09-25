import type { On } from "claude-code";

import { CWD } from "./cwd.ts";
import { DATE } from "./date.ts";
import { WORKDIR } from "./workdir.ts";

export type Entry =
  | { readonly kind: "dir" }
  | { readonly kind: "file" }
  | { readonly kind: "link"; readonly to: string }
  | { readonly kind: "refused"; readonly reason: string };

export type Entries = ReadonlyMap<string, Entry>;

type Found =
  | { readonly kind: "landed"; readonly real: string; readonly entry: Entry }
  | { readonly kind: "dangling" }
  | { readonly kind: "missing" }
  | { readonly kind: "refused"; readonly reason: string };

export const DIR: Entry = { kind: "dir" };

export const FILE: Entry = { kind: "file" };

export function link(to: string): Entry {
  return { kind: "link", to };
}

/** A path whose stat is refused, and every path under it: an OS refusal, or a hook above. */
export function refused(reason: string): Entry {
  return { kind: "refused", reason };
}

const PLANNING: Entries = new Map<string, Entry>([
  [CWD, DIR],
  [`${CWD}/src`, DIR],
  [`${CWD}/src/cli.ts`, FILE],
  [`${CWD}/plans`, DIR],
  [`${CWD}/plans/${DATE}`, DIR],
  [`${CWD}/${WORKDIR}`.slice(0, -1), DIR],
]);

const NETWORK = /^[\\/]{2}/u;

const DRIVE_ROOT = /^[A-Za-z]:\\/u;

/**
 * The path as this disk keys it, POSIX. The engine resolves a path before the hook reads it: on
 * Windows `/project` arrives as `C:\project`, rooted on the drive of the engine's directory. The
 * disk has one root, so any drive is that root; the kit's sandbox has no `process` to name it.
 */
function keyed(path: string): string {
  return DRIVE_ROOT.test(path) ? `/${path.slice(3).replaceAll("\\", "/")}` : path;
}

function folded(path: string): string[] {
  const segments: string[] = [];

  for (const segment of (path.startsWith("/") ? path : `${CWD}/${path}`).split("/")) {
    if (segment === "..") segments.pop();
    else if (segment !== "" && segment !== ".") segments.push(segment);
  }

  return segments;
}

/**
 * `$.fs.stat` over a project that plans, plus `more`, keyed by absolute path. As measured on
 * the engine: a `//` path is refused as a network location, `.` and `..` fold before any link
 * is read, a missing path rejects `ENOENT`, a link that leads nowhere answers `isLink` with no
 * `realPath`, and `realPath` comes with `resolve` alone. A `refused` path rejects with its own
 * reason, as another errno or a hook above does.
 */
export function disk(on: On, more: Entries = new Map()): void {
  const entries: Entries = new Map([...PLANNING, ...more]);

  function find(path: string): Found {
    const asked = `/${folded(path).join("/")}`;
    let real = "";

    for (const segment of folded(path)) {
      const next = `${real}/${segment}`;
      const entry = entries.get(next);

      if (entry === undefined) return { kind: "missing" };

      if (entry.kind === "refused") return entry;

      if (entry.kind !== "link") {
        real = next;
        continue;
      }

      const target = find(entry.to.startsWith("/") ? entry.to : `${real}/${entry.to}`);

      if (target.kind !== "landed") return { kind: next === asked ? "dangling" : "missing" };
      real = target.real;
    }

    return { kind: "landed", real: real === "" ? "/" : real, entry: entries.get(real) ?? DIR };
  }

  on("fs.stat", (_, e) => {
    if (NETWORK.test(e.path)) {
      return { deny: "fs.stat: a network location is not reached from here" };
    }

    const path = keyed(e.path);
    const found = find(path);

    if (found.kind === "missing") return { deny: `$.fs.stat(${e.path}) failed: ENOENT` };

    if (found.kind === "refused") return { deny: found.reason };
    const isLink = entries.get(`/${folded(path).join("/")}`)?.kind === "link";
    const unresolved = { kind: "other", size: 0, mtimeMs: 0, isLink } as const;

    if (found.kind === "dangling" || !e.resolve) return { value: unresolved };

    return {
      value: {
        ...unresolved,
        kind: found.entry.kind === "file" ? "file" : "dir",
        realPath: found.real,
      },
    };
  });
}
