import { existsSync } from "node:fs";

import { configPath } from "../config.ts";
import { loadProfile } from "../profile.ts";
import { realPathOf } from "../scope.ts";
import { liveOthers } from "../state.ts";
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

  const checkouts = new Set<string>();
  const views = viewsOf(parseLine(command), command, cwd, { exists: existsSync }, {});

  for (const view of views.values()) {
    const invocation = gitCommandOf(texts(view.unwrapped.argv));

    const checkout =
      invocation === null || !CHECKOUT_WRITES.has(invocation.subcommand) || view.cwd === null
        ? null
        : mainCheckoutOf(view.cwd, invocation.location);

    if (checkout !== null) {
      checkouts.add(checkout);
    }
  }

  const lines = [...checkouts].flatMap((checkout) => lineFor(checkout, sessionId, now) ?? []);

  return lines.length === 0 ? null : lines.join("\n");
}

/** The main checkout a git invocation acts on, symlinks resolved; null in a linked worktree or outside git. */
function mainCheckoutOf(dir: string, location: readonly string[]): string | null {
  const top = rootOf(dir, location);

  if (top === null) {
    return null;
  }

  const [gitDir, commonDir] =
    git(top, [], ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"])?.split(
      "\n",
    ) ?? [];

  return gitDir !== undefined && gitDir === commonDir ? realPathOf(top) : null;
}

function lineFor(checkout: string, sessionId: string, now: number): string | null {
  const profile = loadProfile(configPath(checkout));

  if (
    profile.worktree.kind !== "read" ||
    profile.worktree.value !== "per-task" ||
    liveOthers(checkout, sessionId, now).length === 0
  ) {
    return null;
  }

  const trunk =
    profile.landing.kind === "read"
      ? profile.landing.value.trunk
      : (git(checkout, [], ["symbolic-ref", "--quiet", "--short", "HEAD"]) ?? "HEAD");

  return `agent-hooks: another session is live in ${checkout}, and this repository takes one worktree per task: do this task in a worktree of its own, not in this checkout. Create one with git -C ${checkout} worktree add <path> -b <branch> ${trunk}`;
}
