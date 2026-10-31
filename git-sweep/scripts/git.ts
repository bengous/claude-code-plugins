// The one git runner of both scripts, and the ref type every git call that
// names a branch takes.

import { GitError, git as runGit, gitRead as readGit } from "../lib/platform/node.ts";

export { GitError };

export type GitResult = { stdout: string; stderr: string; exitCode: number };

// git translates the messages the scripts parse (`[would prune]`,
// `remote ref does not exist`); LC_ALL=C pins them.
const C_LOCALE = { cLocale: true } as const;

// For a command whose exit code is the answer (is-ancestor, --verify, config).
export async function git(...args: string[]): Promise<GitResult> {
  const result = await runGit(args, C_LOCALE);

  if (result.kind !== "exited") throw new GitError(args, result);

  return { stdout: result.stdout.trim(), stderr: result.stderr.trim(), exitCode: result.code };
}

// For a command that must succeed: a failure is an environment problem the
// caller cannot answer, so it throws with the command attached.
export function gitRead(...args: string[]): Promise<string> {
  return readGit(args, C_LOCALE);
}

export const LOCAL_REFS = "refs/heads/";

declare const RefBrand: unique symbol;

// A full ref name. git resolves a short name through refs/tags before
// refs/heads, so a tag named like a branch would silently stand in for it in
// every proof: every git call that names a branch takes a Ref.
export type Ref = string & { readonly [RefBrand]: true };

// SAFETY: the refs/heads/ prefix is what makes the string a full ref, and these
// two constructors are the only places a Ref is minted.
export const localRef = (branch: string): Ref => `${LOCAL_REFS}${branch}` as Ref;

// `remoteBranch` as git prints it short: `origin/feature`.
// SAFETY: same invariant as localRef, under refs/remotes/.
export const remoteRef = (remoteBranch: string): Ref => `refs/remotes/${remoteBranch}` as Ref;

// Every ref under `prefix`, as the names that follow it.
export async function listRefs(prefix: string, ...filters: string[]): Promise<string[]> {
  const out = await gitRead("for-each-ref", "--format=%(refname)", ...filters, prefix);

  return out
    .split("\n")
    .filter((ref) => ref.startsWith(prefix))
    .map((ref) => ref.slice(prefix.length));
}
