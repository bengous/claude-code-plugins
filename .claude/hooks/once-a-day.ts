/**
 * What a SessionStart hook that starts a detached job at most once a day, from
 * the main checkout only, needs: the main checkout's common dir, and the day
 * the job last started, claimed before the start.
 */

import { readFileSync } from "node:fs";

import { writeAtomicSync } from "../../tools/platform/fs.ts";
import { gitRead } from "../../tools/platform/git.ts";
import { isErrno } from "../../tools/platform/pure.ts";

const pad = (value: number): string => String(value).padStart(2, "0");

/** The local calendar day, `YYYY-MM-DD`. */
export function dayOf(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function lastDay(file: string): string | null {
  try {
    return readFileSync(file, "utf8").trim();
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw error;
  }
}

/** The common dir when `root` is the main worktree, null in a linked one. */
export async function mainCommonDir(root: string): Promise<string | null> {
  const dirs = await gitRead([
    "-C",
    root,
    "rev-parse",
    "--path-format=absolute",
    "--git-dir",
    "--git-common-dir",
  ]);

  const [gitDir, commonDir] = dirs.split("\n");

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

  writeAtomicSync(dayFile, today, { mkdir: true });

  return true;
}
