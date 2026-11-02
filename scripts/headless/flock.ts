/**
 * flock(2) on an open file, through libc. The kernel ties the lock to the open
 * file description and drops it when the last descriptor closes, the process
 * ending included, however it ends: no lock outlives its holder, and no pid
 * has to be judged alive. Linux only, as the repository's tooling is; a file
 * Bun opens is close-on-exec, so a child never inherits the lock.
 */

import { dlopen, FFIType, read } from "bun:ffi";

const LOCK_SH = 1;

const LOCK_EX = 2;

const LOCK_NB = 4;

const LOCK_UN = 8;

const EWOULDBLOCK = 11;

export type LockMode = "shared" | "exclusive";

const openLibc = () =>
  dlopen("libc.so.6", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    __errno_location: { args: [], returns: FFIType.ptr },
  });

let libc: ReturnType<typeof openLibc> | undefined;

function errno(): number {
  libc ??= openLibc();
  // oxlint-disable-next-line no-underscore-dangle -- glibc's own symbol name, which dlopen must match.
  const location = libc.symbols.__errno_location();

  if (location === null) throw new Error("libc answered no errno location");

  return read.i32(location, 0);
}

/** Takes the lock on `fd` without waiting; false while another open file holds a conflicting one. */
export function tryLock(fd: number, mode: LockMode): boolean {
  libc ??= openLibc();

  if (libc.symbols.flock(fd, (mode === "shared" ? LOCK_SH : LOCK_EX) | LOCK_NB) === 0) return true;

  const code = errno();

  if (code === EWOULDBLOCK) return false;

  throw new Error(`flock(${fd}) failed with errno ${code}`);
}

export function unlock(fd: number): void {
  libc ??= openLibc();

  if (libc.symbols.flock(fd, LOCK_UN) !== 0) {
    throw new Error(`flock(${fd}, LOCK_UN) failed with errno ${errno()}`);
  }
}
