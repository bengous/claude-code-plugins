/**
 * What a SessionStart hook that starts a detached job at most once a day, from
 * the main checkout only, needs: the main checkout's common dir, and the day
 * the job last started, claimed before the start.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { $ } from "bun";

const pad = (value: number): string => String(value).padStart(2, "0");

/** The local calendar day, `YYYY-MM-DD`. */
export function dayOf(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function isErrnoException(cause: unknown): cause is NodeJS.ErrnoException {
  return cause instanceof Error && "code" in cause;
}

function lastDay(file: string): string | null {
  try {
    return readFileSync(file, "utf8").trim();
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

/** The common dir when `root` is the main worktree, null in a linked one. */
export async function mainCommonDir(root: string): Promise<string | null> {
  const [gitDir, commonDir] = (
    await $`git -C ${root} rev-parse --path-format=absolute --git-dir --git-common-dir`.text()
  )
    .trim()
    .split("\n");

  if (gitDir === undefined || commonDir === undefined) {
    throw new Error(`git rev-parse in ${root} printed no git dir and common dir`);
  }

  return gitDir === commonDir ? commonDir : null;
}

/**
 * Notes today in `dayFile` and answers true, or answers false when it holds
 * today already. Two sessions starting in the same instant can both claim it:
 * the day is read, then written.
 */
export function claimToday(dayFile: string): boolean {
  const today = dayOf(new Date());

  if (lastDay(dayFile) === today) return false;

  mkdirSync(dirname(dayFile), { recursive: true });
  writeFileSync(dayFile, today);

  return true;
}
