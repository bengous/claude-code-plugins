import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, sep } from "node:path";

import { DRAFTS, MAP_FILE, THREADS_FILE } from "../model/folder.ts";

export const TYPES_FILE = "atlas.d.ts";

export const TSCONFIG_FILE = "tsconfig.json";

const IGNORE_FILE = ".gitignore";

const BASE_FILE = ".base";

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const BASE_LINE = /^([0-9a-f]{64}) {2}(.+)$/u;

export class DraftError extends Error {}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- it reads what a catch clause caught, which TypeScript types unknown: anything can be thrown.
export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const walk = (dir: string, sub: string): string[] =>
  readdirSync(join(dir, sub), { withFileTypes: true }).flatMap((entry) => {
    const path = sub === "" ? entry.name : `${sub}/${entry.name}`;

    if (entry.name.startsWith(".") || path === DRAFTS) {
      return [];
    }

    if (entry.isDirectory()) {
      return walk(dir, path);
    }

    return entry.name.endsWith(".ts") && (entry.isFile() || entry.isSymbolicLink()) ? [path] : [];
  });

// A link to a folder is no directory to `withFileTypes`, so the walk never leaves the map folder.
const sourcesOf = (dir: string): string[] => walk(dir, "").toSorted();

/** The files a map's author writes: every .ts file but the generated atlas.d.ts. */
export const dataFilesOf = (dir: string): string[] =>
  sourcesOf(dir).filter((file) => file !== TYPES_FILE);

const IGNORED = new Set([DRAFTS, `${DRAFTS}/`, `/${DRAFTS}`, `/${DRAFTS}/`]);

export function ignoreDrafts(dir: string): void {
  const file = join(dir, IGNORE_FILE);
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";

  if (text.split("\n").some((line) => IGNORED.has(line.trim()))) {
    return;
  }

  const separator = text === "" || text.endsWith("\n") ? "" : "\n";
  writeFileSync(file, `${text}${separator}${DRAFTS}/\n`);
}

const isPresent = (path: string): boolean =>
  lstatSync(path, { throwIfNoEntry: false }) !== undefined;

// `dir` is a real path: a drafts folder or a draft that is no link sits inside it.
function draftPath(dir: string, name: string): string {
  if (!KEBAB.test(name)) {
    throw new DraftError(`draft name ${name}: kebab-case, as split-storage`);
  }

  const drafts = join(dir, DRAFTS);
  const path = join(drafts, name);

  for (const entry of [drafts, path]) {
    if (lstatSync(entry, { throwIfNoEntry: false })?.isSymbolicLink() === true) {
      throw new DraftError(`${entry} is a link: a draft lives inside its map folder`);
    }
  }

  return path;
}

function existingDraft(dir: string, name: string): string {
  const path = draftPath(dir, name);

  if (!existsSync(join(path, MAP_FILE))) {
    throw new DraftError(`no draft ${name}: ${path} holds no ${MAP_FILE}`);
  }

  return path;
}

/** What a draft brings back to its map: the data files and threads.json. */
const trackedOf = (dir: string): string[] => [
  ...dataFilesOf(dir),
  ...(isPresent(join(dir, THREADS_FILE)) ? [THREADS_FILE] : []),
];

const hash = (file: string): string =>
  new Bun.CryptoHasher("sha256").update(readFileSync(file)).digest("hex");

const hashesOf = (dir: string): ReadonlyMap<string, string> =>
  new Map(trackedOf(dir).map((file) => [file, hash(join(dir, file))]));

function copy(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { verbatimSymlinks: true });
}

// A link is copied as it is, two folders deeper: only a relative one that stays in the map lands
// on the draft's own copy of its target.
function refuseOutwardLink(dir: string, file: string): void {
  const path = join(dir, file);

  if (!lstatSync(path).isSymbolicLink()) {
    return;
  }

  const target = readlinkSync(path);

  if (isAbsolute(target) || !realpathSync(path).startsWith(`${dir}${sep}`)) {
    throw new DraftError(
      `${file} links to ${target}, which a draft cannot carry: only a relative link to a file of the map folder is drafted`,
    );
  }
}

/**
 * Copies the map's own files into drafts/<name>, never a dot entry nor another draft, and records
 * there, as `sha256sum` prints them, the hashes of the data files and threads.json the draft
 * starts from.
 */
export function makeDraft(dir: string, name: string): string {
  const path = draftPath(dir, name);

  if (isPresent(path)) {
    throw new DraftError(`${path} exists: adopt it (--adopt) or drop it (--drop) first`);
  }

  ignoreDrafts(dir);

  const files = [
    ...sourcesOf(dir),
    ...[THREADS_FILE, TSCONFIG_FILE].filter((file) => isPresent(join(dir, file))),
  ];

  try {
    for (const file of files) {
      refuseOutwardLink(dir, file);
    }

    const base = [...hashesOf(dir)].map(([file, digest]) => `${digest}  ${file}\n`).join("");

    for (const file of files) {
      copy(join(dir, file), join(path, file));
    }

    writeFileSync(join(path, BASE_FILE), base);
  } catch (error: unknown) {
    rmSync(path, { recursive: true, force: true });
    throw new DraftError(`${messageOf(error)}: no draft made`);
  }

  return path;
}

function unchanged<T>(read: () => T): T {
  try {
    return read();
  } catch (error: unknown) {
    throw new DraftError(`${messageOf(error)}: nothing was changed`);
  }
}

function baseOf(path: string): ReadonlyMap<string, string> {
  const file = join(path, BASE_FILE);

  if (!existsSync(file)) {
    throw new DraftError(`${file} is missing: adopt takes a draft that draft made`);
  }

  const lines = readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "");

  return new Map(
    lines.map((line) => {
      const [, digest, data] = BASE_LINE.exec(line) ?? [];

      if (digest === undefined || data === undefined) {
        throw new DraftError(`${file}: "${line}" is no "<sha256>  <file>" line`);
      }

      return [data, digest];
    }),
  );
}

export type Adopted = { readonly path: string; readonly warnings: readonly string[] };

/**
 * Copies the draft's data files and threads.json over the map's, deletes the map's data files the
 * draft dropped, and deletes the draft. The map's generated files and every other file stay as
 * they are. Refused when one of those files of the map changed since the draft was made.
 * Everything is staged first and renamed into place after: a failure leaves the map as it was. Once
 * the map is switched, a draft that cannot be removed is a warning.
 */
export function adoptDraft(dir: string, name: string): Adopted {
  const path = existingDraft(dir, name);
  const base = baseOf(path);
  const live = unchanged(() => hashesOf(dir));

  const changed = [...new Set([...base.keys(), ...live.keys()])]
    .filter((file) => base.get(file) !== live.get(file))
    .toSorted();

  if (changed.length > 0) {
    throw new DraftError(
      `the map changed since the draft was made (${changed.join(", ")}): adopting would overwrite it, so nothing was changed; drop the draft and draft again, or bring those files back`,
    );
  }

  const incoming = trackedOf(path);
  const outgoing = [...live.keys()].filter((file) => !incoming.includes(file));
  const work = unchanged(() => mkdtempSync(join(dir, DRAFTS, ".adopt-")));
  const moved: (readonly [string, string])[] = [];
  const made: string[] = [];

  const move = (from: string, to: string): void => {
    const folder = mkdirSync(dirname(to), { recursive: true });

    if (folder !== undefined) {
      made.push(folder);
    }

    renameSync(from, to);
    moved.push([from, to]);
  };

  try {
    for (const file of incoming) {
      copy(join(path, file), join(work, "draft", file));
    }

    for (const file of [...incoming, ...outgoing].filter((f) => live.has(f))) {
      move(join(dir, file), join(work, "map", file));
    }

    for (const file of incoming) {
      move(join(work, "draft", file), join(dir, file));
    }
  } catch (error: unknown) {
    for (const [from, to] of moved.toReversed()) {
      renameSync(to, from);
    }

    for (const folder of made.toReversed()) {
      rmSync(folder, { recursive: true, force: true });
    }

    rmSync(work, { recursive: true, force: true });
    throw new DraftError(`${messageOf(error)}: nothing was changed`);
  }

  const leftovers = [
    { folder: work, what: `the staging folder ${work}` },
    { folder: path, what: "the draft" },
  ];

  const warnings = leftovers.flatMap(({ folder, what }) => {
    try {
      rmSync(folder, { recursive: true });

      return [];
    } catch (error: unknown) {
      return [`could not remove ${what}: ${messageOf(error)}`];
    }
  });

  return { path, warnings };
}

export function dropDraft(dir: string, name: string): string {
  const path = existingDraft(dir, name);
  rmSync(path, { recursive: true });

  return path;
}
