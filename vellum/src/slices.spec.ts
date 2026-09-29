import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { PageExtension } from "./runtime/extension.ts";
import { engineExtensions } from "./runtime/hooks/slices.ts";
import { pageExtensions } from "./runtime/page/slices.ts";
import { serverExtensions } from "./runtime/server/slices.ts";
import type { Listen, PageSlot, SliceDecl } from "./workshop/plugs.ts";

/**
 * Each half of a slice holds to its declaration at run time, whatever the compiler saw: a tool, a
 * listener, a route or a slot built through a variable is caught here, which a literal's excess
 * check alone would let through. Each registry holds a half under the id its folder declares, and
 * holds the halves the folders hold, no more.
 */

const SRC = import.meta.dir;

/** The folders that hold the parts, a folder each: the steps Vellum follows, the formats it reads a document in. */
const PART_GROUPS = ["steps", "formats"];

const LISTENS = ["prompted", "answered", "agentAnswered", "staged", "closing"] as const;

const SLOTS = ["renderers", "send", "actions", "notices", "panel"] as const;

/** Both lists name every listener and every slot, and the workshop every slot the page offers: one more in either fails here. */
const EVERY: [
  | Exclude<Listen, (typeof LISTENS)[number]>
  | Exclude<PageSlot, (typeof SLOTS)[number]>
  | Exclude<Exclude<keyof PageExtension, "id">, PageSlot>,
] extends [never]
  ? true
  : never = true;

// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- a half as this suite reads it off a module found on disk: its keys are what is checked, its values are never read.
type Found = { readonly [key: string]: unknown };

function isFound(value: unknown): value is Found {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- an export of a module found on disk arrives as whatever the file exports: this is the check that it is an object before its keys are read.
  return typeof value === "object" && value !== null;
}

/** Every part's folder, as `<group>/<name>` under `src/`: each one a slice. */
function folders(): readonly string[] {
  return PART_GROUPS.flatMap((group) =>
    readdirSync(join(SRC, group), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map(({ name }) => `${group}/${name}`),
  );
}

async function exported(folder: string, file: string, name: string): Promise<Found | null> {
  const path = join(SRC, folder, file);

  if (!existsSync(path)) return null;
  const module: Found = await import(path);
  const value = module[name];

  if (!isFound(value)) throw new Error(`src/${folder}/${file} exports no ${name}`);

  return value;
}

async function declarationOf(folder: string): Promise<SliceDecl> {
  const declared = await exported(folder, "contract.ts", "SLICE");

  if (declared === null) {
    throw new Error(`src/${folder}/contract.ts exports no SLICE = defineSlice({...})`);
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

/** The id under which `folder`'s half is found among `ids`, a registry's: the one its `contract.ts` declares. */
async function idOf(folder: string, ids: readonly string[]): Promise<string | undefined> {
  const { id } = await declarationOf(folder);

  return ids.find((one) => one === id);
}

function routesOf(declared: SliceDecl): readonly string[] {
  return Object.keys(declared.routes ?? {});
}

function readingOf(declared: SliceDecl): readonly string[] {
  return Object.entries(declared.routes ?? {})
    .filter(([, route]) => route?.method === "POST" || route?.query === true)
    .map(([key]) => key);
}

async function hooksBroken(folder: string, declared: SliceDecl): Promise<readonly string[]> {
  const file = `src/${folder}/hooks.ts`;
  const half = await exported(folder, "hooks.ts", "hooks");
  const hooks = declared.hooks ?? {};

  if (half === null) {
    return Object.keys(hooks).length === 0
      ? []
      : [`${file} is missing: contract.ts declares a hooks half`];
  }

  return [
    ...differing(file, "tool", keysIn(half, "tools"), hooks.tools ?? []),
    ...differing(file, "listener", present(half, LISTENS), hooks.listens ?? []),
    ...differing(file, "answer parser of", keysIn(half, "answers"), [
      ...(hooks.posts ?? []),
      ...(hooks.gets ?? []),
    ]),
    ...differing(file, "refusal of", keysIn(half, "refuses"), hooks.denies ?? []),
  ];
}

async function serverBroken(folder: string, declared: SliceDecl): Promise<readonly string[]> {
  const file = `src/${folder}/server.ts`;
  const half = await exported(folder, "server.ts", "server");

  const working = declared.events !== undefined || declared.hears !== undefined;

  if (half === null) {
    return routesOf(declared).length === 0 && !working && declared.linkedDocs === undefined
      ? []
      : [`${file} is missing: contract.ts declares routes, events or linkedDocs`];
  }

  return [
    ...differing(file, "route", keysIn(half, "routes"), routesOf(declared)),
    ...differing(file, "parser of", keysIn(half, "bodies"), readingOf(declared)),
    ...differing(file, "workflow", present(half, ["workflow"]), working ? ["workflow"] : []),
    ...differing(
      file,
      "reader of the plan's links,",
      present(half, ["linkedDocs"]),
      declared.linkedDocs === undefined ? [] : ["linkedDocs"],
    ),
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

async function pageBroken(folder: string, declared: SliceDecl): Promise<readonly string[]> {
  const file = `src/${folder}/page.tsx`;
  const half = await exported(folder, "page.tsx", "page");

  if (half === null) {
    return (declared.page ?? []).length === 0
      ? []
      : [`${file} is missing: contract.ts declares page slots`];
  }

  return differing(file, "slot", present(half, SLOTS), declared.page ?? []);
}

describe("a slice's halves hold to its declaration", () => {
  test("the declaration is the folder's: each half carries SLICE.id", async () => {
    const halves = [
      { file: "hooks.ts", name: "hooks" },
      { file: "server.ts", name: "server" },
      { file: "page.tsx", name: "page" },
    ];

    const broken = await Promise.all(
      folders().map(async (folder) => {
        const { id } = await declarationOf(folder);

        const carried = await Promise.all(
          halves.map(async ({ file, name }) => ({
            file,
            half: await exported(folder, file, name),
          })),
        );

        return carried.flatMap(({ file, half }) =>
          half === null || half.id === id ? [] : [`src/${folder}/${file} carries no id ${id}`],
        );
      }),
    );

    expect(broken.flat()).toEqual([]);
  });

  test("each half has what the declaration declares, and nothing else", async () => {
    const broken = await Promise.all(
      folders().map(async (folder) => {
        const declared = await declarationOf(folder);

        return [
          ...(await hooksBroken(folder, declared)),
          ...(await serverBroken(folder, declared)),
          ...(await pageBroken(folder, declared)),
        ];
      }),
    );

    expect(EVERY).toBe(true);
    expect(broken.flat()).toEqual([]);
  });
});

describe("the three registries", () => {
  test("each holds a half under its declared id for each folder holding that half, and no other", async () => {
    const halves = [
      {
        registry: "hooks/slices.ts",
        files: ["hooks.ts"],
        ids: engineExtensions.map(({ id }) => id),
      },
      {
        registry: "server/slices.ts",
        files: ["server.ts"],
        ids: serverExtensions.map(({ id }) => id),
      },
      { registry: "page/slices.ts", files: ["page.tsx"], ids: pageExtensions.map(({ id }) => id) },
    ];

    const broken = await Promise.all(
      halves.map(async ({ registry, files, ids }) => {
        const holding = await Promise.all(
          folders()
            .filter((folder) => files.some((file) => existsSync(join(SRC, folder, file))))
            .map(async (folder) => ({ folder, id: await idOf(folder, ids) })),
        );

        return [
          ...holding
            .filter(({ id }) => id === undefined)
            .map(({ folder }) => `src/runtime/${registry} holds no half of src/${folder}`),
          ...ids
            .filter((id) => !holding.some((held) => held.id === id))
            .map((id) => `src/runtime/${registry} holds ${id}, which no folder's half is`),
        ];
      }),
    );

    expect(broken.flat()).toEqual([]);
  });
});
