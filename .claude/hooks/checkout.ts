/**
 * Which checkout of the project's repository a directory belongs to. The
 * project and its worktrees share one git common dir; another repository,
 * such as the private `plans/` nested in the project, has its own.
 */

import { realpath } from "node:fs/promises";
import { dirname } from "node:path";

import { $ } from "bun";

export type Place =
  | { kind: "checkout"; root: string }
  | { kind: "other-repository" }
  | { kind: "no-repository" };

interface Repository {
  toplevel: string;
  commonDir: string;
}

let discoveryEnv: Promise<Record<string, string | undefined>> | undefined;

/**
 * The hook's environment without the variables that pin git to one
 * repository, such as `GIT_DIR` exported by a git hook up the process tree:
 * with them, every directory reads as a checkout rooted at itself. `LC_ALL=C`
 * keeps the "not a git repository" message matchable.
 */
function gitDiscoveryEnv(): Promise<Record<string, string | undefined>> {
  discoveryEnv ??= $`git rev-parse --local-env-vars`.text().then((names) => {
    const pinning = new Set(names.split("\n"));
    const kept = Object.entries(process.env).filter(([name]) => !pinning.has(name));

    return { ...Object.fromEntries(kept), LC_ALL: "C" };
  });

  return discoveryEnv;
}

async function repositoryAt(dir: string): Promise<Repository | null> {
  const run =
    await $`git -C ${dir} rev-parse --path-format=absolute --show-toplevel --git-common-dir`
      .env(await gitDiscoveryEnv())
      .nothrow()
      .quiet();

  if (run.exitCode !== 0) {
    const stderr = run.stderr.toString();

    if (stderr.includes("not a git repository")) return null;

    throw new Error(`git rev-parse in ${dir} exited ${run.exitCode}: ${stderr.trim()}`);
  }

  const [toplevel, commonDir] = run.text().trim().split("\n");

  if (toplevel === undefined || commonDir === undefined) {
    throw new Error(`git rev-parse in ${dir} printed no toplevel and common dir: ${run.text()}`);
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
