import { join, resolve } from "node:path";

import { THREADS_FILE, planOf } from "./folder.ts";
import type { Threads, Who } from "./threads.ts";
import { WHO, appendEntry, formatThreads, openItems, readThreads } from "./threads.ts";

// Adds an entry to the thread of an open point in a map folder's threads.json:
//   bun atlas/reply.ts <map folder> <open id> --as agent|human "<text>"
// An agent always writes as `agent`. serve.ts runs this script for a reply
// sent from the page, so a data edit counts without a server restart.
export class ReplyError extends Error {}

export async function appendReply(
  file: string,
  known: ReadonlySet<string>,
  id: string,
  who: Who,
  text: string,
): Promise<Threads> {
  if (!known.has(id)) {
    throw new ReplyError(`unknown open id ${id}: bun check.ts <map folder> --open lists them`);
  }

  if (text.trim() === "") {
    throw new ReplyError("the reply text is empty");
  }

  const { threads, errors } = readThreads(await Bun.file(file).json());

  if (errors.length > 0) {
    throw new ReplyError(`${file} is invalid:\n${errors.join("\n")}`);
  }

  const next = appendEntry(threads, id, { who, text: text.trim() });
  await Bun.write(file, formatThreads(next));

  return next;
}

const USAGE = 'usage: bun reply.ts <map folder> <open id> --as agent|human "<text>"';

type ReplyArgs = {
  readonly dir: string;
  readonly id: string;
  readonly who: Who;
  readonly text: string;
};

function parseArgs(args: readonly string[]): ReplyArgs {
  const at = args.indexOf("--as");
  const who = at === -1 ? undefined : args[at + 1];
  const rest = at === -1 ? args : args.filter((_, i) => i !== at && i !== at + 1);
  const [dir, id, text, ...extra] = rest;
  const role = WHO.find((w) => w === who);

  if (
    role === undefined ||
    dir === undefined ||
    id === undefined ||
    text === undefined ||
    extra.length > 0
  ) {
    throw new ReplyError(
      `${USAGE}\n(--as takes ${WHO.join(" or ")}; quote the text as one argument)`,
    );
  }

  return { dir, id, who: role, text };
}

if (import.meta.main) {
  try {
    const { dir, id, who, text } = parseArgs(process.argv.slice(2));
    const folder = resolve(dir);
    const known = new Set(openItems(await planOf(folder)).map((o) => o.id));
    const threads = await appendReply(join(folder, THREADS_FILE), known, id, who, text);
    console.log(
      `${id}: ${threads[id]?.length ?? 0} entries, waits for ${who === "agent" ? "human" : "agent"}`,
    );
  } catch (error: unknown) {
    if (!(error instanceof ReplyError)) {
      throw error;
    }

    console.error(`reply: ${error.message}`);
    process.exit(1);
  }
}
