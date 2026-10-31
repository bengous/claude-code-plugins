import { dirname, join } from "node:path";

import { THREADS_LOCK } from "../model/folder.ts";
import type { Threads, Who } from "../model/threads.ts";
import { appendEntry, formatThreads, readThreads } from "../model/threads.ts";
import { withLock, writeAtomic } from "../platform/node.ts";

// Adds an entry to the thread of an open point in a map folder's threads.json, for
// `cli.ts reply`. An agent always writes as `agent`. serve.ts runs `cli.ts reply` for a reply
// sent from the page, so a data edit counts without a server restart.
export class ReplyError extends Error {}

/**
 * How long a reply waits for another one's write: a holder keeps the lock for one read and one
 * write, so only a lock a killed reply left behind outlasts this, and the error then names it.
 */
const LOCK_TIMEOUT_MS = 5_000;

export async function appendReply(
  file: string,
  known: ReadonlySet<string>,
  id: string,
  who: Who,
  text: string,
): Promise<Threads> {
  if (!known.has(id)) {
    throw new ReplyError(`unknown open id ${id}: cli.ts check <map folder> --open lists them`);
  }

  if (text.trim() === "") {
    throw new ReplyError("the reply text is empty");
  }

  return await withLock(
    join(dirname(file), THREADS_LOCK),
    async () => {
      const { threads, errors } = readThreads(await Bun.file(file).json());

      if (errors.length > 0) {
        throw new ReplyError(`${file} is invalid:\n${errors.join("\n")}`);
      }

      const next = appendEntry(threads, id, { who, text: text.trim() });
      // FIXME: writeAtomic puts a new file in place, so a threads.json that is a symbolic link stops being one at the next reply, and one with a mode of its own takes the default; resolve the link and keep the mode before the write if a map folder ever relies on either.
      await writeAtomic(file, formatThreads(next));

      return next;
    },
    { timeoutMs: LOCK_TIMEOUT_MS },
  );
}
