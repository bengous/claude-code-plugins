/**
 * Which checkout of the project's repository a directory belongs to. The
 * project and its worktrees share one git common dir; another repository,
 * such as the private `.private/` nested in the project, has its own.
 */

import { realpath } from "node:fs/promises";
import { dirname } from "node:path";

import { type EnvOverlay, GitError, git, gitRead } from "../../tools/platform/node.ts";

export type Place =
  | { kind: "checkout"; root: string }
  | { kind: "other-repository" }
  | { kind: "no-repository" };

interface Repository {
  toplevel: string;
  commonDir: string;
}

let discoveryEnv: Promise<EnvOverlay> | undefined;

/**
 * The variables that pin git to one repository, such as `GIT_DIR` exported by
 * a git hook up the process tree, each named `undefined`: laid over the hook's
 * environment, it removes them. With them, every directory reads as a checkout
 * rooted at itself.
 */
export function gitDiscoveryEnv(): Promise<EnvOverlay> {
  discoveryEnv ??= gitRead(["rev-parse", "--local-env-vars"]).then((names) =>
    Object.fromEntries(names.split("\n").map((name) => [name, undefined])),
  );

  return discoveryEnv;
}

async function repositoryAt(dir: string): Promise<Repository | null> {
  const args = [
    "-C",
    dir,
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
    "--git-common-dir",
  ];

  // `LC_ALL=C` keeps the "not a git repository" message matchable.
  const run = await git(args, { env: await gitDiscoveryEnv(), cLocale: true });

  if (run.kind !== "exited" || run.outputLost === true) throw new GitError(args, run);

  if (run.code !== 0) {
    if (run.stderr.includes("not a git repository")) return null;

    throw new Error(`git rev-parse in ${dir} exited ${run.code}: ${run.stderr.trim()}`);
  }

  const [toplevel, commonDir] = run.stdout.trim().split("\n");

  if (toplevel === undefined || commonDir === undefined) {
    throw new Error(`git rev-parse in ${dir} printed no toplevel and common dir: ${run.stdout}`);
  }

  return { toplevel, commonDir: await realpath(commonDir) };
}

/** Where `dir` sits, without looking past the innermost repository around it. */
export async function placeOf(dir: string, projectDir: string): Promise<Place> {
  const around = await repositoryAt(dir);

  if (around === null) return { kind: "no-repository" };

  const project = await repositoryAt(projectDir);

  return around.commonDir === project?.commonDir
    ? { kind: "checkout", root: around.toplevel }
    : { kind: "other-repository" };
}

/**
 * The checkout of the project's repository around `dir`, climbing out of any
 * other repository nested in it, else the project.
 */
export async function checkoutRoot(dir: string | undefined, projectDir: string): Promise<string> {
  if (dir === undefined) return projectDir;

  const project = await repositoryAt(projectDir);
  let around = await repositoryAt(dir);

  while (around !== null && around.commonDir !== project?.commonDir) {
    const parent = dirname(around.toplevel);

    around = parent === around.toplevel ? null : await repositoryAt(parent);
  }

  return around?.toplevel ?? projectDir;
}
