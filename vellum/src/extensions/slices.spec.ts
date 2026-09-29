import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { Listen } from "../core/engine/extension.ts";
import type { PageSlot } from "../core/extension.ts";
import type { SliceDecl } from "../core/plugs.ts";
import { engineExtensions } from "./engine.ts";
import { pageExtensions } from "./page.ts";
import { serverExtensions } from "./server.ts";

/**
 * Each half of a slice holds to its declaration at run time, whatever the compiler saw: a tool, a
 * listener, a route or a slot built through a variable is caught here, which a literal's excess
 * check alone would let through. Each registry holds a half under its folder's name, and holds
 * the halves the folders hold, no more.
 */

const EXTENSIONS = import.meta.dir;

const LISTENS = ["prompted", "answered", "agentAnswered", "staged", "closing"] as const;

const SLOTS = ["renderers", "send", "actions", "notices", "panel"] as const;

/** Both lists name every listener and every slot: one more in either type fails here. */
const EVERY: [
  Exclude<Listen, (typeof LISTENS)[number]> | Exclude<PageSlot, (typeof SLOTS)[number]>,
] extends [never]
  ? true
  : never = true;

// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- a half as this suite reads it off a module found on disk: its keys are what is checked, its values are never read.
type Found = { readonly [key: string]: unknown };

function isFound(value: unknown): value is Found {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- an export of a module found on disk arrives as whatever the file exports: this is the check that it is an object before its keys are read.
  return typeof value === "object" && value !== null;
}

function folders(): readonly string[] {
  return readdirSync(EXTENSIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map(({ name }) => name);
}

function slices(): readonly string[] {
  return folders().filter((id) => existsSync(join(EXTENSIONS, id, "contract.ts")));
}

async function exported(id: string, file: string, name: string): Promise<Found | null> {
  const path = join(EXTENSIONS, id, file);

  if (!existsSync(path)) return null;
  const module: Found = await import(path);
  const value = module[name];

  if (!isFound(value)) throw new Error(`src/extensions/${id}/${file} exports no ${name}`);

  return value;
}

async function declarationOf(id: string): Promise<SliceDecl> {
  const declared = await exported(id, "contract.ts", "SLICE");

  if (declared === null) {
    throw new Error(`src/extensions/${id}/contract.ts exports no SLICE = defineSlice({...})`);
  }

  // SAFETY: `SLICE` is the value `defineSlice` returned, checked against `SliceDecl` by the compiler where it is written.
  return declared as SliceDecl;
}

/** The keys of the object `half` holds under `key`, none when it holds none. */
function keysIn(half: Found, key: string): readonly string[] {
  const value = half[key];

  return isFound(value) ? Object.keys(value).toSorted() : [];
}

function present(half: Found, names: readonly string[]): readonly string[] {
  return names.filter((name) => half[name] !== undefined).toSorted();
}

/** What `file`'s half has against what the declaration says, as `<what> <name>` lines, empty when they agree. */
function differing(
  file: string,
  what: string,
  has: readonly string[],
  declared: readonly string[],
): readonly string[] {
  const wanted = [...declared].toSorted();

  return [
    ...has.flatMap((name) =>
      wanted.includes(name)
        ? []
        : [`${file} has the ${what} ${name}, which contract.ts does not declare`],
    ),
    ...wanted.flatMap((name) =>
      has.includes(name) ? [] : [`${file} lacks the ${what} ${name}, which contract.ts declares`],
    ),
  ];
}

function routesOf(declared: SliceDecl): readonly string[] {
  return Object.keys(declared.routes ?? {});
}

function readingOf(declared: SliceDecl): readonly string[] {
  return Object.entries(declared.routes ?? {})
    .filter(([, route]) => route?.method === "POST" || route?.query === true)
    .map(([key]) => key);
}

async function hooksBroken(id: string, declared: SliceDecl): Promise<readonly string[]> {
  const file = `src/extensions/${id}/hooks.ts`;
  const half = await exported(id, "hooks.ts", "hooks");
  const hooks = declared.hooks ?? {};

  if (half === null) {
    return Object.keys(hooks).length === 0
      ? []
      : [`${file} is missing: contract.ts declares a hooks half`];
  }

  return [
    ...differing(file, "tool", keysIn(half, "tools"), hooks.tools ?? []),
    ...differing(file, "listener", present(half, LISTENS), hooks.listens ?? []),
    ...differing(file, "answer parser of", keysIn(half, "answers"), hooks.posts ?? []),
    ...differing(file, "refusal of", keysIn(half, "refuses"), hooks.denies ?? []),
  ];
}

async function serverBroken(id: string, declared: SliceDecl): Promise<readonly string[]> {
  const file = `src/extensions/${id}/server.ts`;
  const half = await exported(id, "server.ts", "server");

  if (half === null) {
    return routesOf(declared).length === 0 && declared.events === undefined
      ? []
      : [`${file} is missing: contract.ts declares routes or events`];
  }

  return [
    ...differing(file, "route", keysIn(half, "routes"), routesOf(declared)),
    ...differing(file, "parser of", keysIn(half, "bodies"), readingOf(declared)),
    ...differing(
      file,
      "opening",
      present(half, ["opened", "start"]),
      declared.opened === undefined ? [] : ["opened", "start"],
    ),
    ...differing(
      file,
      "Send part",
      present(half, ["part"]),
      declared.sends === undefined ? [] : ["part"],
    ),
  ];
}

async function pageBroken(id: string, declared: SliceDecl): Promise<readonly string[]> {
  const file = `src/extensions/${id}/page.tsx`;
  const half = await exported(id, "page.tsx", "page");

  if (half === null) {
    return (declared.page ?? []).length === 0
      ? []
      : [`${file} is missing: contract.ts declares page slots`];
  }

  return differing(file, "slot", present(half, SLOTS), declared.page ?? []);
}

describe("a slice's halves hold to its declaration", () => {
  test("the declaration is the folder's: SLICE.id is its name", async () => {
    const named = await Promise.all(slices().map(async (id) => [id, (await declarationOf(id)).id]));

    expect(named.filter(([folder, id]) => folder !== id)).toEqual([]);
  });

  test("each half has what the declaration declares, and nothing else", async () => {
    const broken = await Promise.all(
      slices().map(async (id) => {
        const declared = await declarationOf(id);

        return [
          ...(await hooksBroken(id, declared)),
          ...(await serverBroken(id, declared)),
          ...(await pageBroken(id, declared)),
        ];
      }),
    );

    expect(EVERY).toBe(true);
    expect(broken.flat()).toEqual([]);
  });
});

describe("the three registries", () => {
  test("each holds a half under its folder's name for each folder holding that half, and no other", () => {
    const halves = [
      {
        registry: "engine.ts",
        files: ["engine.ts", "hooks.ts"],
        ids: engineExtensions.map(({ id }) => id),
      },
      { registry: "server.ts", files: ["server.ts"], ids: serverExtensions.map(({ id }) => id) },
      { registry: "page.ts", files: ["page.tsx"], ids: pageExtensions.map(({ id }) => id) },
    ];

    const broken = halves.flatMap(({ registry, files, ids }) => {
      const holding = folders().filter((id) =>
        files.some((file) => existsSync(join(EXTENSIONS, id, file))),
      );

      return [
        ...holding
          .filter((id) => !ids.includes(id))
          .map((id) => `src/extensions/${registry} holds no half of ${id}`),
        ...ids
          .filter((id) => !holding.includes(id))
          .map((id) => `src/extensions/${registry} holds ${id}, which no folder's half is`),
      ];
    });

    expect(broken).toEqual([]);
  });
});
