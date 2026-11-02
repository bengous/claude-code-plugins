/**
 * The landing lock: one landing at a time pushes to `dev` from this machine. An exclusive flock(2) on
 * `~/.cache/claude-code-plugins/landing/<sha1 of origin's push URL>.lock`, so every checkout and worktree of the
 * repository shares it, with a `.json` beside it naming the holder. The kernel drops the lock when its holder ends,
 * however it ends: the flock decides, and a holder file left behind names nobody. The pre-push hook refuses a push
 * to `dev` while another process holds it (`lock-check.ts`); the landing's own push names its pid in
 * `LANDING_LOCK_HOLDER` and goes through. The lock is local: every landing runs on one workstation.
 */

import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, rmSync } from "node:fs";
import { constants, homedir } from "node:os";
import { dirname, join } from "node:path";

import { writeAtomicSync } from "../../tools/platform/fs.ts";
import { messageOf } from "../../tools/platform/pure.ts";
import { parsePushedRefs } from "../gates/check-e2e-green.ts";
import { tryLock } from "../headless/flock.ts";
import { type LockPaths, runState, STOP_SIGNALS } from "../headless/headless-run.ts";
import type { Clock } from "./ci-wait.ts";

/** Set in the environment of the landing's push to `dev`: the pid holding the lock, which the pre-push lets through. */
export const HOLDER_ENV = "LANDING_LOCK_HOLDER";

/** The directory of the locks, `~/.cache/claude-code-plugins/landing` unless set. */
export const DIR_ENV = "LANDING_LOCK_DIR";

const POLL_MS = 5_000;

export interface Holder {
  readonly pid: number;
  readonly branch: string;
  readonly since: string;
}

export type LockRefused = { readonly kind: "refused"; readonly why: string };

/**
 * One spelling of a repository's URL whatever the clone used: `git@github.com:o/r.git`, `https://github.com/o/r`
 * and `ssh://git@github.com/o/r.git` all read `github.com/o/r`, so clones that spell origin apart share the lock.
 */
export function repositoryOf(url: string): string {
  const scp = /^[^@/:]+@([^:/]+):(.+)$/u.exec(url);

  const path =
    scp === null ? url.replace(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?/iu, "") : `${scp[1]}/${scp[2]}`;

  return path
    .replace(/\/+$/u, "")
    .replace(/\.git$/u, "")
    .toLowerCase();
}

export function lockPaths(originUrl: string): LockPaths {
  const dir = process.env[DIR_ENV] ?? join(homedir(), ".cache", "claude-code-plugins", "landing");
  const name = createHash("sha1").update(repositoryOf(originUrl)).digest("hex");

  return { lock: join(dir, `${name}.lock`), holder: join(dir, `${name}.json`) };
}

function refused(why: string): LockRefused {
  return { kind: "refused", why };
}

function named(holder: Holder | null): string {
  return holder === null
    ? "a process that has not named itself yet"
    : `pid ${holder.pid} (${holder.branch}) since ${holder.since}`;
}

/** The lock once taken, polled every 5 s; false once `timeoutMs` passed with another process holding it. */
async function taken(
  fd: number,
  { clock, timeoutMs }: { readonly clock: Clock; readonly timeoutMs: number },
): Promise<boolean> {
  const start = clock.now();

  while (!tryLock(fd, "exclusive")) {
    const left = timeoutMs - (clock.now() - start);

    if (left <= 0) return false;

    await clock.sleep(Math.min(POLL_MS, left));
  }

  return true;
}

/**
 * Runs `fn` under the landing lock of `originUrl`, waited for at most `timeoutMs`. Refused, without running `fn`,
 * while another landing holds it past that wait, or when the lock does not open or take; released once `fn` ends,
 * throws, or the process is stopped by a signal.
 */
export async function withLandingLock<T>(
  originUrl: string,
  branch: string,
  waiting: { readonly clock: Clock; readonly timeoutMs: number },
  fn: () => Promise<T>,
): Promise<T | LockRefused> {
  const paths = lockPaths(originUrl);
  let fd: number;

  try {
    mkdirSync(dirname(paths.lock), { recursive: true });
    fd = openSync(paths.lock, "a");
  } catch (error) {
    return refused(`the landing lock ${paths.lock} does not open: ${messageOf(error)}`);
  }

  // The holder file is removed before the descriptor closes: once closed, the next holder may already have written its own.
  const release = () => {
    rmSync(paths.holder, { force: true });
    closeSync(fd);
  };

  let held = false;

  try {
    held = await taken(fd, waiting);

    if (!held) {
      closeSync(fd);

      const state = runState<Holder>(paths);
      const holder = state.kind === "running" ? state.holder : null;

      return refused(`dev is being landed by ${named(holder)}: land again`);
    }

    const holder: Holder = { pid: process.pid, branch, since: new Date().toISOString() };

    writeAtomicSync(paths.holder, JSON.stringify(holder));
  } catch (error) {
    if (held) release();
    else closeSync(fd);

    return refused(`the landing lock ${paths.lock} does not take: ${messageOf(error)}`);
  }

  const stop = (signal: NodeJS.Signals) => {
    release();
    process.exit(128 + constants.signals[signal]);
  };

  for (const signal of STOP_SIGNALS) process.on(signal, stop);

  try {
    return await fn();
  } finally {
    for (const signal of STOP_SIGNALS) process.off(signal, stop);
    release();
  }
}

/**
 * Why the pre-push hook refuses a push to `originUrl`, git's pushed-ref `lines` naming the refs it moves: a push to
 * `dev` while a process other than `holderPid`, the landing that pushes, holds the landing lock. Null when it may go.
 */
export function pushRefusal(
  lines: string,
  originUrl: string,
  holderPid: string | undefined,
): string | null {
  if (parsePushedRefs(lines).length === 0) return null;

  const state = runState<Holder>(lockPaths(originUrl));

  if (state.kind === "idle") return null;

  if (state.holder !== null && String(state.holder.pid) === holderPid) return null;

  return `a landing holds dev (${named(state.holder)}): push to dev again once it ends`;
}
