import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { RegistryEntry } from "../shared/wire.ts";

/**
 * What a server keeps on disk, under `<dir>` (`~/.claude/pinpoint` outside the tests):
 * `sessions/<session>.json`, the registry entry the Vite plugin reads; `sessions/<session>/seq`,
 * the last batch number given; `sessions/<session>/pending/<seq>.json`, each batch not yet
 * handed to the session, so a server started again on the same session tells it again.
 */

export type Pending = { readonly seq: number; readonly text: string };

export type SessionFiles = {
  readonly writeEntry: (entry: RegistryEntry) => Promise<void>;
  readonly removeEntry: () => Promise<void>;
  /** The next batch number, kept across servers of one session. */
  readonly nextSeq: () => Promise<number>;
  readonly keepPending: (pending: Pending) => Promise<void>;
  readonly dropPending: (seq: number) => Promise<void>;
  /** Every batch not yet handed to the session, oldest first. */
  readonly pending: () => Promise<Pending[]>;
  /** The session's directory and entry, for `/pinpoint:stop`. */
  readonly removeAll: () => Promise<void>;
};

const PENDING_FILE = /^(\d+)\.json$/u;

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- the boundary parsers of the files on disk: a pending file read back, a registry entry another server wrote. */
function parsePending(value: unknown): Pending | null {
  return typeof value === "object" &&
    value !== null &&
    "seq" in value &&
    "text" in value &&
    typeof value.seq === "number" &&
    typeof value.text === "string"
    ? { seq: value.seq, text: value.text }
    : null;
}

/** The pid of a registry entry, the one field `pruneEntries` reads; `null` for a file that holds none. */
function pidOf(value: unknown): number | null {
  return typeof value === "object" &&
    value !== null &&
    "pid" in value &&
    typeof value.pid === "number"
    ? value.pid
    : null;
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof */

export function sessionFiles(dir: string, session: string): SessionFiles {
  const sessions = join(dir, "sessions");
  const own = join(sessions, session);
  const pendingDir = join(own, "pending");
  const seqFile = join(own, "seq");
  const entryFile = join(sessions, `${session}.json`);

  return {
    writeEntry: async (entry) => {
      await mkdir(sessions, { recursive: true });
      await writeFile(entryFile, `${JSON.stringify(entry)}\n`);
    },
    removeEntry: () => rm(entryFile, { force: true }),
    nextSeq: async () => {
      await mkdir(own, { recursive: true });
      const last = Number.parseInt(await readFile(seqFile, "utf8").catch(() => "0"), 10);
      const next = (Number.isNaN(last) ? 0 : last) + 1;
      await writeFile(seqFile, `${next}\n`);

      return next;
    },
    keepPending: async (pending) => {
      await mkdir(pendingDir, { recursive: true });
      await writeFile(join(pendingDir, `${pending.seq}.json`), JSON.stringify(pending));
    },
    dropPending: (seq) => rm(join(pendingDir, `${seq}.json`), { force: true }),
    pending: async () => {
      const names = await readdir(pendingDir).catch(() => []);

      const read = await Promise.all(
        names
          .filter((name) => PENDING_FILE.test(name))
          .map(async (name) =>
            parsePending(JSON.parse(await readFile(join(pendingDir, name), "utf8"))),
          ),
      );

      return read.filter((one) => one !== null).toSorted((a, b) => a.seq - b.seq);
    },
    removeAll: async () => {
      await rm(entryFile, { force: true });
      await rm(own, { recursive: true, force: true });
    },
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (cause) {
    // EPERM: the process is there, another user's.
    return cause instanceof Error && "code" in cause && cause.code === "EPERM";
  }
}

/** Removes the registry entries whose server is gone: a `claude` killed hard leaves its entry behind. */
export async function pruneEntries(dir: string): Promise<void> {
  const sessions = join(dir, "sessions");
  const names = (await readdir(sessions).catch(() => [])).filter((name) => name.endsWith(".json"));

  await Promise.all(
    names.map(async (name) => {
      const file = join(sessions, name);
      const pid = pidOf(JSON.parse(await readFile(file, "utf8").catch(() => "null")));

      if (pid !== null && !alive(pid)) await rm(file, { force: true });
    }),
  );
}
