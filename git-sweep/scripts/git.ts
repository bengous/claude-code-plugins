// The one git runner of both scripts, and the ref type every git call that
// names a branch takes.

import { $ } from "bun";

export type GitResult = { stdout: string; stderr: string; exitCode: number };

export class GitError extends Error {
  constructor(args: readonly string[], result: GitResult) {
    super(`git ${args.join(" ")} failed (exit ${result.exitCode}): ${result.stderr}`);
    this.name = "GitError";
  }
}

// For a command whose exit code is the answer (is-ancestor, --verify, config).
export async function git(...args: string[]): Promise<GitResult> {
  // git translates the messages the scripts parse (`[would prune]`,
  // `remote ref does not exist`); LC_ALL=C pins them.
  const { stdout, stderr, exitCode } = await $`git ${args}`
    .env({ ...process.env, LC_ALL: "C" })
    .quiet()
    .nothrow();

  return { stdout: stdout.toString().trim(), stderr: stderr.toString().trim(), exitCode };
}

// For a command that must succeed: a failure is an environment problem the
// caller cannot answer, so it throws with the command attached.
export async function gitRead(...args: string[]): Promise<string> {
  const result = await git(...args);

  if (result.exitCode !== 0) throw new GitError(args, result);

  return result.stdout;
}

declare const RefBrand: unique symbol;

// A full ref name. git resolves a short name through refs/tags before
// refs/heads, so a tag named like a branch would silently stand in for it in
// every proof: every git call that names a branch takes a Ref.
export type Ref = string & { readonly [RefBrand]: true };

// SAFETY: the refs/heads/ prefix is what makes the string a full ref, and these
// two constructors are the only places a Ref is minted.
export const localRef = (branch: string): Ref => `refs/heads/${branch}` as Ref;

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
