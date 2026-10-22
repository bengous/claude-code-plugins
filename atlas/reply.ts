import type { Threads, Who } from "./threads.ts";
import { appendEntry, formatThreads, readThreads } from "./threads.ts";

// Adds an entry to the thread of an open point in a map folder's threads.json, for
// `cli.ts reply`. An agent always writes as `agent`. serve.ts runs `cli.ts reply` for a reply
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
    throw new ReplyError(`unknown open id ${id}: cli.ts check <map folder> --open lists them`);
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
