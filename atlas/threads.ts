// Open points (the `open` field of a zone or brick) and their threads, as
// threads.json stores them: { "<open id>": [{ "who", "text" }] }, oldest entry
// first, no date (git keeps the history). Pure: the page, check.ts and
// reply.ts share it, and only reply.ts and serve.ts touch the file.
import type { Plan } from "./model.ts";

export const WHO = ["human", "agent"] as const;

export type Who = (typeof WHO)[number];

export type Entry = { readonly who: Who; readonly text: string };

export type Threads = Readonly<Record<string, readonly Entry[]>>;

export type OpenItem = {
  readonly id: string;
  readonly text: string;
  readonly owner: string;
  readonly ownerLabel: string;
  readonly kind: "zone" | "brick";
};

export function openItems(p: Plan): OpenItem[] {
  const zones = p.zones.flatMap((z) =>
    (z.info.open ?? []).map((o): OpenItem => ({
      id: o.id,
      text: o.text,
      owner: z.id,
      ownerLabel: z.title,
      kind: "zone",
    })),
  );

  const bricks = p.nodes.flatMap((n) =>
    (n.info.open ?? []).map((o): OpenItem => ({
      id: o.id,
      text: o.text,
      owner: n.id,
      ownerLabel: n.label.replaceAll("\n", " "),
      kind: "brick",
    })),
  );

  return [...zones, ...bricks];
}

// A point waits for the party that did not write the last entry; without a
// thread, it waits for nobody.
export function waitsFor(thread: readonly Entry[] | undefined): Who | null {
  const last = thread?.at(-1);

  if (last === undefined) {
    return null;
  }

  return last.who === "human" ? "agent" : "human";
}

// An open point's HTML text as plain text, and its first line.
export const plainText = (html: string): string =>
  html
    .replaceAll(/<[^>]*>/gu, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

export const firstLine = (html: string): string => (plainText(html).split("\n")[0] ?? "").trim();

const isWho = (v: unknown): v is Who => WHO.some((w) => w === v);

export type ReadThreads = { readonly threads: Threads; readonly errors: readonly string[] };

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters -- readThreads IS the boundary parser of threads.json, which a hand edit may have broken: every shape error is listed, none thrown, and nothing past it sees the file untyped. */
export function readThreads(raw: unknown): ReadThreads {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      threads: {},
      errors: ["threads.json: the top level must be an object { <open id>: [entries] }"],
    };
  }

  const threads: Record<string, Entry[]> = {};
  const errors: string[] = [];

  for (const [id, list] of Object.entries(raw)) {
    if (!Array.isArray(list)) {
      errors.push(`threads.json ${id}: a thread must be an array of entries`);
      continue;
    }

    threads[id] = list.flatMap((item: unknown, i): Entry[] => {
      const who: unknown =
        typeof item === "object" && item !== null && "who" in item ? item.who : undefined;

      const text: unknown =
        typeof item === "object" && item !== null && "text" in item ? item.text : undefined;

      if (!isWho(who)) {
        errors.push(
          `threads.json ${id}[${i}]: who must be one of ${WHO.join(", ")}, got ${JSON.stringify(who)}`,
        );

        return [];
      }

      if (typeof text !== "string" || text.trim() === "") {
        errors.push(`threads.json ${id}[${i}]: text must be a non-empty string`);

        return [];
      }

      return [{ who, text }];
    });
  }

  return { threads, errors };
}

// A thread already present keeps its place in the file.
export const appendEntry = (threads: Threads, id: string, entry: Entry): Threads =>
  Object.fromEntries([...Object.entries(threads), [id, [...(threads[id] ?? []), entry]]]);

export const formatThreads = (threads: Threads): string => `${JSON.stringify(threads, null, 2)}\n`;
