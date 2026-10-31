import { GitError, git } from "../../tools/platform/node.ts";

const LIST = ["ls-files", "-z", "--cached", "--others", "--exclude-standard"];

/**
 * The working tree's files, as the repo-wide gates read them: tracked files,
 * plus untracked files no ignore rule covers. oxlint, oxfmt and tsgo walk the
 * same set, so a file created but never staged meets every gate at once.
 */
export async function workingTreeFiles(cwd = process.cwd()): Promise<string[]> {
  const listed = await git(LIST, { cwd });

  if (listed.kind !== "exited" || listed.code !== 0) throw new GitError(LIST, listed);

  return listed.stdout.split("\0").filter(Boolean);
}
