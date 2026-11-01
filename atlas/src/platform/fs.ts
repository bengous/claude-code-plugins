import { linkSync, mkdirSync, renameSync as fsRenameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, rename as fsRename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { isErrno } from "./pure.ts";

const HELD_CODES: ReadonlySet<unknown> = new Set(["EBUSY", "EPERM", "EACCES"]);

const HELD_RETRY_STEP_MS = 100;

/**
 * Whether Windows refused a rename because a program holds the file or folder (`EBUSY`, `EPERM`,
 * `EACCES`). POSIX renames a held folder, and an `EPERM` there is a real refusal: always false.
 */
export function isHeld(cause: unknown): boolean {
  return (
    process.platform === "win32" &&
    cause instanceof Error &&
    "code" in cause &&
    HELD_CODES.has(cause.code)
  );
}

export type RenameOptions = {
  /** How long a rename Windows refuses as held is tried again, every 100 ms; `0` by default. */
  readonly heldRetryMs?: number;
};

export async function rename(from: string, to: string, options: RenameOptions = {}): Promise<void> {
  const until = Date.now() + (options.heldRetryMs ?? 0);

  for (;;) {
    try {
      await fsRename(from, to);

      return;
    } catch (cause) {
      if (!isHeld(cause) || Date.now() >= until) throw cause;
      await Bun.sleep(HELD_RETRY_STEP_MS);
    }
  }
}

export function renameSync(from: string, to: string, options: RenameOptions = {}): void {
  const until = Date.now() + (options.heldRetryMs ?? 0);

  for (;;) {
    try {
      fsRenameSync(from, to);

      return;
    } catch (cause) {
      if (!isHeld(cause) || Date.now() >= until) throw cause;
      Bun.sleepSync(HELD_RETRY_STEP_MS);
    }
  }
}

/** A scratch name beside `file`, unique to this write: `.<base>.<pid>.<uuid>.tmp`. */
function scratchBeside(file: string): string {
  return join(dirname(file), `.${basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
}

export type WriteAtomicOptions = RenameOptions & {
  /** Creates the file's directory, and its parents, first. */
  readonly mkdir?: boolean;
};

/**
 * Writes `data` to a scratch file beside `file`, then renames it over `file`: a reader meets the
 * old content or the new, whole, and two writers never rename each other's scratch file. The
 * scratch file is removed when the write or the rename fails. No fsync: a process crash or a
 * concurrent writer is what this guards against, not a power loss. The rename replaces what `file`
 * was: a symbolic link becomes a file, and the mode is the new file's default.
 */
export async function writeAtomic(
  file: string,
  data: string | Uint8Array,
  options: WriteAtomicOptions = {},
): Promise<void> {
  if (options.mkdir === true) await mkdir(dirname(file), { recursive: true });
  const scratch = scratchBeside(file);

  try {
    await writeFile(scratch, data);
    await rename(scratch, file, options);
  } catch (cause) {
    await rm(scratch, { force: true });
    throw cause;
  }
}

export function writeAtomicSync(
  file: string,
  data: string | Uint8Array,
  options: WriteAtomicOptions = {},
): void {
  if (options.mkdir === true) mkdirSync(dirname(file), { recursive: true });
  const scratch = scratchBeside(file);

  try {
    writeFileSync(scratch, data);
    renameSync(scratch, file, options);
  } catch (cause) {
    rmSync(scratch, { force: true });
    throw cause;
  }
}

/**
 * Creates `file` holding `data`, unless it exists: `false` then, and `file` untouched. The data is
 * written to a scratch file first and linked into place, so a reader never meets it half-written.
 */
export function createExclusiveSync(file: string, data: string | Uint8Array): boolean {
  const scratch = scratchBeside(file);

  try {
    writeFileSync(scratch, data);
    linkSync(scratch, file);

    return true;
  } catch (cause) {
    if (isErrno(cause, "EEXIST")) return false;
    throw cause;
  } finally {
    rmSync(scratch, { force: true });
  }
}
