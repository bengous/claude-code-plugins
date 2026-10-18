import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Delivery, Outcome } from "../shared/wire.ts";
import { parseDelivery } from "./parse.ts";

/**
 * What a server keeps on disk, under `<dir>` (`~/.claude/pinpoint` outside the tests):
 * `sessions/<session>/seq`, the last batch number given; `sessions/<session>/pending/<seq>.json`,
 * each batch not yet handed to the session, so a server started again on the same session tells
 * it again; `sessions/<session>/settled.json`, what the module reported of the last batches, so a
 * page asks after its own across a restart; `sessions/<session>/images/<id>.png`, each zone's image
 * a page handed over, until the session's directory goes: at `/pinpoint:stop`, or at the start of
 * another session's server once nothing in it changed for Claude Code's retention period. Each file
 * is written whole under another name, then renamed: a reader never meets half of one.
 */

export type Pending = { readonly seq: number; readonly text: string };

export type SessionFiles = {
  /**
   * The next batch number, kept across servers of one session and past every one the session may
   * have taken; the caller asks one at a time.
   */
  readonly nextSeq: () => Promise<number>;
  readonly keepPending: (pending: Pending) => Promise<void>;
  /** Keeps what the module reported of a batch, then forgets the batch; the caller settles one at a time. */
  readonly settle: (delivery: Delivery) => Promise<void>;
  /** Every batch not yet handed to the session, oldest first. */
  readonly pending: () => Promise<Pending[]>;
  /** What became of each batch of `seqs`, in their order. */
  readonly outcomes: (seqs: readonly number[]) => Promise<Outcome[]>;
  /** Keeps a zone's PNG; answers the id it is kept under. */
  readonly keepImage: (png: Uint8Array) => Promise<string>;
  /** Where the image of `id` is kept, an absolute path. */
  readonly imagePath: (id: string) => string;
  /** The session's directory, for `/pinpoint:stop`. */
  readonly removeAll: () => Promise<void>;
};

/** How many reported batches `settled.json` keeps: a page asks after its own every second. */
const SETTLED_KEPT = 100;

const PENDING_FILE = /^(\d+)\.json$/u;

/* oxlint-disable anti-slop/no-runtime-typeof -- the boundary parsers of the files on disk, which a crash or another process may have left unreadable. */
function parsePending(text: string): Pending | null {
  try {
    const value: unknown = JSON.parse(text);

    return typeof value === "object" &&
      value !== null &&
      "seq" in value &&
      "text" in value &&
      typeof value.seq === "number" &&
      typeof value.text === "string"
      ? { seq: value.seq, text: value.text }
      : null;
  } catch {
    return null;
  }
}
/* oxlint-enable anti-slop/no-runtime-typeof */

function parseSettled(text: string): Delivery[] {
  try {
    const value: unknown = JSON.parse(text);

    return Array.isArray(value) ? value.flatMap((item) => parseDelivery(item) ?? []) : [];
  } catch {
    return [];
  }
}

async function writeWhole(file: string, data: string | Uint8Array): Promise<void> {
  const draft = `${file}.tmp`;
  await writeFile(draft, data);
  await rename(draft, file);
}

function isMissing(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}

/**
 * When anything under `path` last changed: the newest of its files and directories, itself
 * included. One renamed or removed while it is read changed just now.
 */
async function lastChange(path: string): Promise<number> {
  const names = await readdir(path, { recursive: true }).catch((cause: unknown) => {
    if (isMissing(cause)) return [];
    throw cause;
  });

  const times = await Promise.all(
    [path, ...names.map((name) => join(path, name))].map((one) =>
      lstat(one).then(
        (stats) => stats.mtimeMs,
        (cause: unknown) => {
          if (isMissing(cause)) return Infinity;
          throw cause;
        },
      ),
    ),
  );

  return times.reduce((newest, time) => Math.max(newest, time));
}

/**
 * Removes the directory of every session but `session` that nothing changed in for `keepMs`;
 * answers why each one that could not be swept was not.
 */
export async function sweepSessions(
  dir: string,
  session: string,
  keepMs: number,
): Promise<string[]> {
  const sessions = join(dir, "sessions");
  const cutoff = Date.now() - keepMs;

  const entries = await readdir(sessions, { withFileTypes: true }).catch((cause: unknown) => {
    if (isMissing(cause)) return [];
    throw cause;
  });

  const failures = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name !== session)
      .map(async ({ name }) => {
        const path = join(sessions, name);

        try {
          if ((await lastChange(path)) < cutoff) await rm(path, { recursive: true, force: true });

          return [];
        } catch (cause) {
          return [`${name}: ${String(cause)}`];
        }
      }),
  );

  return failures.flat();
}

/** `relayed`: the last batch the module handed to the session before this server. */
export function sessionFiles(dir: string, session: string, relayed: number): SessionFiles {
  const sessions = join(dir, "sessions");
  const own = join(sessions, session);
  const pendingDir = join(own, "pending");
  const seqFile = join(own, "seq");
  const settledFile = join(own, "settled.json");
  const imagesDir = join(own, "images");
  const imagePath = (id: string): string => join(imagesDir, `${id}.png`);

  const pendingNames = async (): Promise<string[]> =>
    (await readdir(pendingDir).catch(() => [])).filter((name) => PENDING_FILE.test(name));

  const settled = async (): Promise<Delivery[]> =>
    parseSettled(await readFile(settledFile, "utf8").catch(() => ""));

  // The module only acknowledges a number at or below the last it handed over: a `seq` removed
  // before this server or since must not number a batch again from 1.
  let given = relayed;

  return {
    nextSeq: async () => {
      await mkdir(own, { recursive: true });
      const last = Number.parseInt(await readFile(seqFile, "utf8").catch(() => "0"), 10);
      const next = Math.max(Number.isNaN(last) ? 0 : last, given) + 1;
      await writeWhole(seqFile, `${next}\n`);
      given = next;

      return next;
    },
    keepPending: async (pending) => {
      await mkdir(pendingDir, { recursive: true });
      await writeWhole(join(pendingDir, `${pending.seq}.json`), JSON.stringify(pending));
    },
    settle: async (delivery) => {
      const others = (await settled()).filter((one) => one.seq !== delivery.seq);
      await writeWhole(settledFile, JSON.stringify([...others, delivery].slice(-SETTLED_KEPT)));
      await rm(join(pendingDir, `${delivery.seq}.json`), { force: true });
    },
    pending: async () => {
      const read = await Promise.all(
        (await pendingNames()).map(async (name) =>
          parsePending(await readFile(join(pendingDir, name), "utf8").catch(() => "")),
        ),
      );

      return read.filter((one) => one !== null).toSorted((a, b) => a.seq - b.seq);
    },
    outcomes: async (seqs) => {
      // Listed before `settled.json` is read, as `settle` writes it before it removes the
      // pending file: a batch settled meanwhile is found in one or the other.
      const waiting = new Set((await pendingNames()).map((name) => Number.parseInt(name, 10)));
      const reported = await settled();

      return seqs.map((seq): Outcome =>
        waiting.has(seq)
          ? { seq, outcome: "pending" }
          : (reported.find((one) => one.seq === seq) ?? { seq, outcome: "unknown" }),
      );
    },
    keepImage: async (png) => {
      const id = crypto.randomUUID();
      await mkdir(imagesDir, { recursive: true });
      await writeWhole(imagePath(id), png);

      return id;
    },
    imagePath,
    removeAll: () => rm(own, { recursive: true, force: true }),
  };
}
