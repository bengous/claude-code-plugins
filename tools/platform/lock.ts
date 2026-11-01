import { open, readFile, rm } from "node:fs/promises";

import { isHeld } from "./fs.ts";
import { isErrno } from "./pure.ts";

const LOCK_POLL_MS = 50;

export type LockOptions = {
  /** How long to wait for another holder to let go before throwing. */
  readonly timeoutMs: number;
};

const LOCK_HOLDER = /^(\d+) (\S+)$/u;

/**
 * What the lock file holds; `null` when there is none to read: its holder let go, or, on Windows,
 * the file it removed is pending deletion (`isHeld`).
 */
function lockText(lockFile: string): Promise<string | null> {
  return readFile(lockFile, "utf8").catch((cause: unknown) => {
    if (isErrno(cause, "ENOENT") || isHeld(cause)) return null;
    throw cause;
  });
}

function heldLockError(lockFile: string, timeoutMs: number, text: string): Error {
  const [, pid, since] = LOCK_HOLDER.exec(text.trim()) ?? [];
  const age = since === undefined ? Number.NaN : Date.now() - Date.parse(since);
  const holder = pid === undefined ? "an unknown holder" : `pid ${pid}`;
  const held = Number.isNaN(age) ? "" : ` for ${age} ms`;

  return new Error(
    `${lockFile} is still locked after ${timeoutMs} ms, by ${holder}${held}; if no such process runs, remove the lock file`,
  );
}

/**
 * An attempt at the lock: `taken`, `held` by another, or `refused` as Windows refuses a file a
 * holder removes while it is pending deletion (`isHeld`), which a real refusal reads as too.
 */
type LockAttempt =
  | { readonly kind: "taken" }
  | { readonly kind: "held" }
  | { readonly kind: "refused"; readonly cause: unknown };

/** Tries to create the lock file with this process's pid and the date. */
async function tryLock(lockFile: string): Promise<LockAttempt> {
  let attempt: LockAttempt = { kind: "held" };

  const handle = await open(lockFile, "wx").catch((cause: unknown) => {
    if (isHeld(cause)) attempt = { kind: "refused", cause };
    else if (!isErrno(cause, "EEXIST")) throw cause;

    return null;
  });

  if (handle === null) return attempt;

  try {
    await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`);
  } catch (cause) {
    await handle.close();
    await rm(lockFile, { force: true });
    throw cause;
  }

  await handle.close();

  return { kind: "taken" };
}

/**
 * Runs `fn` while holding `lockFile`, created exclusively with this process's pid and the date;
 * waits for another holder up to `timeoutMs`, then throws naming the file, the holder's pid and
 * the lock's age. The lock is removed once `fn` settles. A lock its holder left behind is never
 * taken over: it is reported, for a human to remove.
 */
export async function withLock<T>(
  lockFile: string,
  fn: () => Promise<T>,
  options: LockOptions,
): Promise<T> {
  const until = performance.now() + options.timeoutMs;
  let attempt = await tryLock(lockFile);

  while (attempt.kind !== "taken") {
    if (performance.now() >= until) {
      const text = await lockText(lockFile);

      if (text !== null) throw heldLockError(lockFile, options.timeoutMs, text);
      // No lock file to read: its holder let go since the last try, so one more; a refusal that
      // outlasts the wait with no file behind it is a real one, and its own error.
      attempt = await tryLock(lockFile);

      if (attempt.kind === "taken") break;

      if (attempt.kind === "refused") throw attempt.cause;
      throw heldLockError(lockFile, options.timeoutMs, "");
    }

    await Bun.sleep(LOCK_POLL_MS);
    attempt = await tryLock(lockFile);
  }

  try {
    return await fn();
  } finally {
    await rm(lockFile, { force: true });
  }
}
