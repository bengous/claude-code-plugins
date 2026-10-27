import { existsSync } from "node:fs";
import path from "node:path";

import { configPath } from "../config.ts";
import type { LandingProfile } from "../profile.ts";
import { loadProfile } from "../profile.ts";
import { git as runGit } from "../scope.ts";

type ProfileRead =
  | { readonly kind: "profiled"; readonly landing: LandingProfile; readonly landScript: boolean }
  | { readonly kind: "default" }
  /** A config file whose profile cannot be read: the guard refuses every door there. */
  | { readonly kind: "unreadable"; readonly error: string };

export const DEFAULT: ProfileRead = { kind: "default" };

export function git(
  cwd: string,
  location: readonly string[],
  args: readonly string[],
): string | null {
  return runGit(cwd, [...location, ...args])?.trim() ?? null;
}

/**
 * The top of the work tree a git invocation acts on. With `--git-dir` and no `--work-tree`, git takes the cwd as the
 * work tree, so the root is the one that holds the common dir.
 */
export function rootOf(cwd: string, location: readonly string[]): string | null {
  if (!existsSync(cwd)) {
    return null;
  }

  if (location.includes("--git-dir") && !location.includes("--work-tree")) {
    const common = git(cwd, location, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);

    return common !== null && path.basename(common) === ".git" ? path.dirname(common) : null;
  }

  return git(cwd, location, ["rev-parse", "--show-toplevel"]);
}

export function profileOf(root: string): ProfileRead {
  const read = loadProfile(configPath(root)).landing;

  switch (read.kind) {
    case "read": {
      return {
        kind: "profiled",
        landing: read.value,
        landScript: existsSync(path.join(root, "scripts", "land.ts")),
      };
    }

    case "absent": {
      return DEFAULT;
    }

    case "unreadable": {
      return { kind: "unreadable", error: read.error };
    }

    default: {
      const unreachable: never = read;
      throw new Error(`unhandled profile read: ${JSON.stringify(unreachable)}`);
    }
  }
}

/** The remote a push without one goes to, in git's order: the branch's pushRemote, remote.pushDefault, its remote. */
export function defaultRemote(
  cwd: string,
  location: readonly string[],
  branch: string | null,
): string {
  const keys = [
    ...(branch === null ? [] : [`branch.${branch}.pushRemote`]),
    "remote.pushDefault",
    ...(branch === null ? [] : [`branch.${branch}.remote`]),
  ];

  for (const key of keys) {
    const value = git(cwd, location, ["config", "--get", key]);

    if (value !== null && value !== "") {
      return value;
    }
  }

  return "origin";
}

/** The remote branch `@{push}` names, `refs/remotes/<remote>/<branch>` read back to `<branch>`; null when unresolved. */
export function pushBranch(cwd: string, location: readonly string[]): string | null {
  const ref = git(cwd, location, ["rev-parse", "--symbolic-full-name", "@{push}"]);
  const remotes = git(cwd, location, ["remote"])?.split("\n") ?? [];

  const remote = remotes
    .filter((name) => name !== "" && ref?.startsWith(`refs/remotes/${name}/`) === true)
    .toSorted((left, right) => right.length - left.length)
    .at(0);

  return ref === null || remote === undefined ? null : ref.slice(`refs/remotes/${remote}/`.length);
}

export function remoteUrl(cwd: string, location: readonly string[], remote: string): string | null {
  return (
    git(cwd, location, ["remote", "get-url", "--push", remote]) ??
    (/[:/]/u.test(remote) ? remote : null)
  );
}
