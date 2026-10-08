import { join } from "node:path";

const FLOCK = join(import.meta.dir, "flock.ts");

// Takes the exclusive lock, says so, and holds it until its stdin closes.
const HOLDER = `
import { openSync } from "node:fs";
import { tryLock } from ${JSON.stringify(FLOCK)};

const fd = openSync(process.argv[1], "a");
if (!tryLock(fd, "exclusive")) throw new Error("the lock is taken already");
console.log("held");
await Bun.stdin.text();
`;

export interface HeldLock {
  pid: number;
  release: () => Promise<void>;
}

/** Holds `file`'s exclusive lock from another process, as a live run does, until `release`. */
export async function holdLock(file: string): Promise<HeldLock> {
  const holder = Bun.spawn([process.execPath, "-e", HOLDER, file], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });

  const reader = holder.stdout.getReader();
  const first = await reader.read();
  reader.releaseLock();

  if (new TextDecoder().decode(first.value).trim() !== "held") {
    throw new Error(`the lock holder did not take ${file}`);
  }

  return {
    pid: holder.pid,
    release: async () => {
      await holder.stdin.end();
      await holder.exited;
    },
  };
}
