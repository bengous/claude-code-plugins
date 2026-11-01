// The one git runner of both scripts, and the ref type every git call that
// names a branch takes.

import { GitError, git as runGit, type GitResult as RunResult } from "../lib/platform/node.ts";

export { GitError };

export type GitResult = { stdout: string; stderr: string; exitCode: number };

// git translates the messages the scripts parse (`[would prune]`,
// `remote ref does not exist`); LC_ALL=C pins them.
const C_LOCALE = { cLocale: true } as const;

// The platform's git throws a plain Error, with this message, when git is not
// on the PATH. Read here as a command that failed, as Bun's shell answered it:
// an exit-code read sees a failure, and a gitRead throws the GitError both
// entry points catch. 127 is the shell's code for a command not found, which
// no git command answers.
const NO_GIT: RunResult = {
  kind: "exited",
  code: 127,
  stdout: "",
  stderr: "git is not on the PATH",
};

async function runC(args: string[]): Promise<RunResult> {
  try {
    return await runGit(args, C_LOCALE);
  } catch (cause) {
    if (cause instanceof Error && cause.message === NO_GIT.stderr) return NO_GIT;
    throw cause;
  }
}

// For a command whose exit code is the answer (is-ancestor, --verify, config).
// An output let go of past the grace throws: its stdout and stderr read empty.
export async function git(...args: string[]): Promise<GitResult> {
  const result = await runC(args);

  if (result.kind !== "exited" || result.outputLost === true) throw new GitError(args, result);

  return { stdout: result.stdout.trim(), stderr: result.stderr.trim(), exitCode: result.code };
}

// For a command that must succeed: a failure is an environment problem the
// caller cannot answer, so it throws with the command attached.
export async function gitRead(...args: string[]): Promise<string> {
  const result = await runC(args);

  if (result.kind !== "exited" || result.code !== 0 || result.outputLost === true) {
    throw new GitError(args, result);
  }

  return result.stdout.trim();
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
