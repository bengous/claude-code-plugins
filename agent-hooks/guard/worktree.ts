import { existsSync } from "node:fs";

import { configPath } from "../core/config/config.ts";
import { loadProfile } from "../core/config/profile.ts";
import { realPathOf } from "../core/session/scope.ts";
import { liveOthers } from "../core/session/state.ts";
import { gitCommandOf } from "./argv.ts";
import { git, rootOf } from "./repo.ts";
import { parseLine } from "./shell.ts";
import { texts, viewsOf } from "./walk.ts";

/** The git subcommands that move the branch, the index or the history of the checkout they run in. */
const CHECKOUT_WRITES = new Set(["pull", "switch", "checkout", "commit"]);

/**
 * The lines that tell the agent its Bash line runs `git pull`, `switch`, `checkout` or `commit` in the main checkout
 * of a per-task repository another session is live in, one per such checkout; null when it runs none. Each command
 * acts where `git -C`, an earlier `cd` of the line, or the cwd puts it; a linked worktree never counts, and the
 * profile read is that checkout's own.
 */
export function worktreeLine(
  command: string,
  cwd: string,
  sessionId: string,
  now: number,
): string | null {
  if (!/\bgit\b/u.test(command)) {
    return null;
  }

  const tops = new Set<string>();
  const views = viewsOf(parseLine(command), command, cwd, { exists: existsSync }, {});

  for (const view of views.values()) {
    const invocation = gitCommandOf(texts(view.unwrapped.argv));

    const top =
      invocation === null || !CHECKOUT_WRITES.has(invocation.subcommand) || view.cwd === null
        ? null
        : rootOf(view.cwd, invocation.location);

    if (top !== null) {
      tops.add(top);
    }
  }

  const lines = [...tops].flatMap((top) => lineFor(top, sessionId, now) ?? []);

  return lines.length === 0 ? null : lines.join("\n");
}

/** Whether the work tree at `top` is its repository's main checkout, not a linked worktree. */
function isMainCheckout(top: string): boolean {
  const [gitDir, commonDir] =
    git(top, [], ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"])?.split(
      "\n",
    ) ?? [];

  return gitDir !== undefined && gitDir === commonDir;
}

/** The line for the work tree at `top`: its own profile first, which spares a git run in a shared repository. */
function lineFor(top: string, sessionId: string, now: number): string | null {
  const profile = loadProfile(configPath(top));

  if (
    profile.worktree.kind !== "read" ||
    profile.worktree.value !== "per-task" ||
    !isMainCheckout(top)
  ) {
    return null;
  }

  const checkout = realPathOf(top);

  if (liveOthers(checkout, sessionId, now).length === 0) {
    return null;
  }

  const trunk =
    profile.landing.kind === "read"
      ? profile.landing.value.trunk
      : (git(checkout, [], ["symbolic-ref", "--quiet", "--short", "HEAD"]) ?? "HEAD");

  return `agent-hooks: another session is live in ${checkout}, and this repository takes one worktree per task: do this task in a worktree of its own, not in this checkout. Create one with git -C ${checkout} worktree add <path> -b <branch> ${trunk}`;
}
