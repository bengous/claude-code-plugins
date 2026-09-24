/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof -- this harness asserts on the JSON that git-clean-audit.ts prints on stdout: the casts and typeof checks ARE the boundary parse, and a closed type here would assert the schema instead of the behaviour. */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "git-clean-audit.ts");

let tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const safe = prefix.replaceAll(/[^a-zA-Z0-9-]/gu, "-");
  const dir = mkdtempSync(join(tmpdir(), `git-clean-audit-test-${safe}-`));
  tmpDirs.push(dir);

  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }

  tmpDirs = [];
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...GIT_ISOLATION },
  });

  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`git ${args.join(" ")} failed (${exitCode}): ${stderr}`);
  }

  return stdout.trim();
}

// Isolated from the developer's global/system git config: a real sweep.* key
// there would silently change what these tests assert.
const GIT_ISOLATION = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

async function runAudit(
  cwd: string,
  ...args: string[]
): Promise<{ exitCode: number; result: Record<string, unknown> }> {
  const proc = Bun.spawn(["bun", "run", SCRIPT, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...GIT_ISOLATION },
  });

  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  try {
    return { exitCode, result: JSON.parse(stdout.trim()) };
  } catch {
    return {
      exitCode,
      result: { ok: false, error: `parse-error: ${stdout.trim()}`, step: "unknown" },
    };
  }
}

async function makeRepo(prefix: string): Promise<string> {
  const repo = makeTmpDir(prefix);
  await git(repo, "init", "--initial-branch=main");
  await git(repo, "config", "user.email", "test@test.com");
  await git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "init.txt"), "init");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "initial commit");

  return repo;
}

async function makeRepoWithOrigin(prefix: string): Promise<{ origin: string; repo: string }> {
  const origin = makeTmpDir(`${prefix}-origin`);
  const repo = makeTmpDir(prefix);
  await git(origin, "init", "--bare", "--initial-branch=main");
  await git(repo, "init", "--initial-branch=main");
  await git(repo, "remote", "add", "origin", origin);
  await git(repo, "config", "user.email", "test@test.com");
  await git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "init.txt"), "init");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "initial commit");
  await git(repo, "push", "-u", "origin", "main");

  return { origin, repo };
}

async function addCommit(repo: string, filename: string, message: string): Promise<void> {
  writeFileSync(join(repo, filename), message);
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", message);
}

// Commits what is staged with both dates set in the past.
async function commitDaysAgo(repo: string, message: string, days: number): Promise<void> {
  const date = new Date(Date.now() - days * 86_400_000).toISOString();

  const proc = Bun.spawn(["git", "commit", "-m", message], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...GIT_ISOLATION, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });

  if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
}

type Kept = { name: string; reason: string; detail: string | null };

const keptNames = (result: Record<string, unknown>): string[] =>
  (result.kept as Kept[]).map((k) => k.name);

const keptEntry = (result: Record<string, unknown>, name: string): Kept | undefined =>
  (result.kept as Kept[]).find((k) => k.name === name);

type KeptWorktree = { path: string; branch: string | null; reason: string; detail: string | null };

// Each fixture below has one linked worktree, so counts stand in for paths:
// git may spell a temporary path differently (a symlinked tmpdir) than the test.
const worktreeCounts = (result: Record<string, unknown>) => {
  const categories = result.categories as Record<string, unknown[]>;

  return {
    stale: categories.stale_worktrees?.length,
    removable: categories.removable_worktrees?.length,
    kept: (result.kept_worktrees as KeptWorktree[]).length,
  };
};

const categoryNames = (result: Record<string, unknown>): string[] =>
  Object.values(result.categories as Record<string, { name?: string; branch?: string }[]>)
    .flat()
    .map((entry) => entry.name ?? entry.branch ?? "");

const onlyKeptWorktree = (result: Record<string, unknown>): KeptWorktree | undefined =>
  (result.kept_worktrees as KeptWorktree[])[0];

// Run the audit with a git shim prepended to PATH that fails only on the given
// subcommand (e.g. "worktree list"), delegating everything else to the real git.
async function runAuditWithFailingGit(
  cwd: string,
  failOn: string,
  ...args: string[]
): Promise<{ exitCode: number; result: Record<string, unknown> }> {
  const realGit = Bun.which("git");

  if (!realGit) throw new Error("git not found on PATH");
  const shimDir = makeTmpDir("git-shim");

  const shim = `#!/usr/bin/env bash
if [[ "$*" == "${failOn}"* ]]; then
  echo "fatal: simulated failure: ${failOn}" >&2
  exit 128
fi
exec ${realGit} "$@"
`;

  writeFileSync(join(shimDir, "git"), shim, { mode: 0o755 });

  const proc = Bun.spawn(["bun", "run", SCRIPT, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...GIT_ISOLATION, PATH: `${shimDir}:${process.env.PATH}` },
  });

  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  try {
    return { exitCode, result: JSON.parse(stdout.trim()) };
  } catch {
    return {
      exitCode,
      result: { ok: false, error: `parse-error: ${stdout.trim()}`, step: "unknown" },
    };
  }
}

// Run the audit with PATH reduced to a shim dir holding a symlink to the real
// git and, when fixtures are given, a `gh` serving them from files. `null`
// writes no `gh` at all, so the binary is genuinely absent rather than failing.
// Invoking bun by absolute path is what lets PATH hold nothing else.
//   pulls        — `api repos/.../commits/<sha>/pulls`, by sha
//   merged       — `pr list`, the merged pull requests
//   forcePushes  — `api graphql`, by pull request number: the former heads, as
//                  the audit's `--jq` prints them, one oid per line
type GhFixtures = {
  nameWithOwner: string | null;
  pulls: Record<string, unknown[]>;
  merged?: unknown[];
  forcePushes?: Record<number, string[]>;
};

async function runAuditWithGh(
  cwd: string,
  fixtures: GhFixtures | null,
  ...args: string[]
): Promise<{ exitCode: number; result: Record<string, unknown> }> {
  const realGit = Bun.which("git");

  if (!realGit) throw new Error("git not found on PATH");
  const shimDir = makeTmpDir("gh-shim");
  symlinkSync(realGit, join(shimDir, "git"));

  if (fixtures !== null) {
    if (fixtures.nameWithOwner !== null) {
      writeFileSync(
        join(shimDir, "repo-view.json"),
        JSON.stringify({ nameWithOwner: fixtures.nameWithOwner }),
      );
    }

    for (const [sha, pulls] of Object.entries(fixtures.pulls)) {
      writeFileSync(join(shimDir, `${sha}.json`), JSON.stringify(pulls));
    }

    if (fixtures.merged !== undefined) {
      writeFileSync(join(shimDir, "merged.json"), JSON.stringify(fixtures.merged));
    }

    for (const [number, heads] of Object.entries(fixtures.forcePushes ?? {})) {
      writeFileSync(join(shimDir, `force-pushes-${number}.txt`), heads.join("\n"));
    }

    // Absolute shebang and bash builtins only: PATH holds no `env` and no `cat`.
    writeFileSync(
      join(shimDir, "gh"),
      `#!/bin/bash
case "$1 $2" in
  "repo view") f="${shimDir}/repo-view.json" ;;
  "pr list") f="${shimDir}/merged.json" ;;
  "api graphql")
    [[ "$*" =~ number=([0-9]+) ]] || exit 1
    f="${shimDir}/force-pushes-\${BASH_REMATCH[1]}.txt"
    ;;
  "api repos/"*)
    sha="\${2#*/commits/}"
    f="${shimDir}/\${sha%/pulls}.json"
    ;;
  *) exit 1 ;;
esac
[[ -f "$f" ]] || {
  echo "gh: no fixture for $*" >&2
  exit 1
}
printf '%s\\n' "$(<"$f")"
`,
      { mode: 0o755 },
    );
  }

  const proc = Bun.spawn([process.execPath, "run", SCRIPT, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...GIT_ISOLATION, PATH: shimDir },
  });

  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  try {
    return { exitCode, result: JSON.parse(stdout.trim()) };
  } catch {
    return {
      exitCode,
      result: { ok: false, error: `parse-error: ${stdout.trim()}`, step: "unknown" },
    };
  }
}

async function commitFile(
  repo: string,
  file: string,
  content: string,
  message: string,
): Promise<void> {
  writeFileSync(join(repo, file), content);
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", message);
}

const MERGED_BRANCH = "feature/squashed";

const BASE_LINES = "line1\nline2\nline3\n";

const WITH_A = `${BASE_LINES}branch A\n`;

// Several lines, so a conflict resolved on one of them leaves a patch that
// range-diff still pairs with the original.
const WITH_AB = `${WITH_A}${["B1", "B2", "B3", "B4", "B5", "B6"].map((line) => `branch ${line}\n`).join("")}`;

const MAIN_REWROTE = WITH_AB.replace("branch A", "main rewrote A");

// A base commit plus a branch appending two lines to it, HEAD back on main.
async function makeBaseAndBranch(prefix: string): Promise<{ origin: string; repo: string }> {
  const { origin, repo } = await makeRepoWithOrigin(prefix);
  await commitFile(repo, "f.txt", BASE_LINES, "base: add f");
  await git(repo, "push", "origin", "main");
  await git(repo, "checkout", "-b", MERGED_BRANCH);
  await commitFile(repo, "f.txt", WITH_A, "feature: add A");
  await commitFile(repo, "f.txt", WITH_AB, "feature: add B");
  await git(repo, "checkout", "main");

  return { origin, repo };
}

async function squashMerge(repo: string): Promise<string> {
  await git(repo, "merge", "--squash", MERGED_BRANCH);
  await git(repo, "commit", "-m", "squash: feature");

  return git(repo, "rev-parse", "HEAD");
}

// The shape that defeats both local proofs: main takes the branch's content
// (squash, or cherry-pick for a rebase merge) and then rewrites a line the
// branch added, so the tip is no ancestor and merge-tree conflicts.
async function makeMergedThenEdited(
  prefix: string,
  how: "squash" | "cherry-pick",
): Promise<{ origin: string; repo: string }> {
  const { origin, repo } = await makeBaseAndBranch(prefix);

  if (how === "squash") {
    await squashMerge(repo);
  } else {
    // Onto its own parent, cherry-pick recreates the very same commits; landing
    // on a main that moved first gives the new shas a rebase merge produces.
    await commitFile(repo, "other.txt", "unrelated\n", "main: unrelated work");
    await git(repo, "cherry-pick", `${MERGED_BRANCH}~2..${MERGED_BRANCH}`);
  }

  await commitFile(repo, "f.txt", MAIN_REWROTE, "main: rewrite A");
  await git(repo, "push", "origin", "main");

  return { origin, repo };
}

// One entry of `gh pr list --json number,headRefName,headRefOid,mergeCommit`.
const listedPull = (number: number, head: string, landing: string) => ({
  number,
  headRefName: MERGED_BRANCH,
  headRefOid: head,
  mergeCommit: { oid: landing },
});

// One entry of the REST `commits/{sha}/pulls` answer; `landing` null is a pull
// request that never merged.
const restPull = (number: number, head: string, landing: string | null) => ({
  number,
  merged_at: landing === null ? null : "2026-09-10T12:01:27Z",
  head: { ref: MERGED_BRANCH, sha: head },
  merge_commit_sha: landing,
});

const RESOLVED_B = WITH_AB.replace("branch B4", "branch B4, resolved");

// Another checkout lands the pushed branch while `repo` keeps its pre-rebase
// copy: main moves, A and B are rebased onto it (B resolved differently when a
// conflict is simulated), the result becomes PR #number's head, lands, and the
// branch is deleted on origin. Main then rewrites A, which defeats both local
// proofs. `repo` pulls main only, so a squash-landed head is not local.
async function landElsewhere(
  origin: string,
  repo: string,
  number: number,
  how: { landing: "fast-forward" | "squash"; resolveB: boolean },
): Promise<{ head: string; landing: string }> {
  await git(repo, "push", "-u", "origin", MERGED_BRANCH);

  const [a = "", b = ""] = (
    await git(repo, "rev-list", "--reverse", `main..${MERGED_BRANCH}`)
  ).split("\n");

  const other = makeTmpDir("land-elsewhere");
  await git(other, "clone", origin, other);
  await git(other, "config", "user.email", "test@test.com");
  await git(other, "config", "user.name", "Test");
  await commitFile(other, "other.txt", "unrelated\n", "main: unrelated work");
  await git(other, "checkout", "-b", "rebased");
  await git(other, "cherry-pick", a);

  if (how.resolveB) await commitFile(other, "f.txt", RESOLVED_B, "feature: add B");
  else await git(other, "cherry-pick", b);

  const head = await git(other, "rev-parse", "HEAD");
  await git(other, "push", "-f", "origin", `rebased:refs/heads/${MERGED_BRANCH}`);
  await git(other, "push", "origin", `rebased:refs/pull/${number}/head`);
  await git(other, "checkout", "main");

  if (how.landing === "fast-forward") {
    await git(other, "merge", "--ff-only", "rebased");
  } else {
    await git(other, "merge", "--squash", "rebased");
    await git(other, "commit", "-m", `feature (#${number})`);
  }

  const landing = await git(other, "rev-parse", "HEAD");
  const landed = how.resolveB ? RESOLVED_B : WITH_AB;
  await commitFile(other, "f.txt", landed.replace("branch A", "main rewrote A"), "main: rewrite A");
  await git(other, "push", "origin", "main");
  await git(other, "push", "origin", "--delete", MERGED_BRANCH);

  await git(repo, "fetch", "origin", "main");
  await git(repo, "merge", "--ff-only", "origin/main");

  return { head, landing };
}

type Proven = { name: string; proof: string };

const provenNames = (result: Record<string, unknown>, category: string): string[] =>
  ((result.categories as Record<string, Proven[]>)[category] ?? []).map((b) => b.name);

const provenEntry = (
  result: Record<string, unknown>,
  category: string,
  name: string,
): Proven | undefined =>
  ((result.categories as Record<string, Proven[]>)[category] ?? []).find((b) => b.name === name);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("git-clean-audit", () => {
  test("returns empty categories on clean repo", async () => {
    const repo = await makeRepo("clean");
    const { exitCode, result } = await runAudit(repo);

    expect(exitCode).toBe(0);
    expect(result.ok).toBe(true);
    const categories = result.categories as Record<string, unknown[]>;
    expect(categories.merged_local).toHaveLength(0);
    expect(categories.orphaned_worktree).toHaveLength(0);
    expect(categories.content_merged).toHaveLength(0);
    expect(categories.backup).toHaveLength(0);
    expect(categories.stale_worktrees).toHaveLength(0);
    expect(categories.removable_worktrees).toHaveLength(0);
  });

  test("detects merged local branches", async () => {
    const repo = await makeRepo("merged");

    // Create and merge a feature branch
    await git(repo, "checkout", "-b", "feature/done");
    await addCommit(repo, "feature.txt", "feature work");
    await git(repo, "checkout", "main");
    await git(repo, "merge", "feature/done");

    const { result } = await runAudit(repo);
    const categories = result.categories as Record<string, unknown[]>;

    expect(categories.merged_local).toHaveLength(1);
    expect((categories.merged_local?.[0] as { name: string } | undefined)?.name).toBe(
      "feature/done",
    );
  });

  test("detects orphaned worktree-agent branches", async () => {
    const repo = await makeRepo("orphaned");

    // Create a worktree-agent branch (merged)
    await git(repo, "checkout", "-b", "worktree-agent-abc123");
    await git(repo, "checkout", "main");

    const { result } = await runAudit(repo);
    const categories = result.categories as Record<string, unknown[]>;

    expect(categories.orphaned_worktree).toHaveLength(1);
    expect((categories.orphaned_worktree?.[0] as { name: string } | undefined)?.name).toBe(
      "worktree-agent-abc123",
    );
    // Should NOT be in merged_local
    expect(categories.merged_local).toHaveLength(0);
  });

  test("offers an unmerged worktree-agent branch once its content is proven", async () => {
    const repo = await makeRepo("orphaned-unmerged");

    // Not an ancestor of main, but squashed onto it: the commits are gone from
    // main's history while every file it carries is there.
    await git(repo, "checkout", "-b", "worktree-agent-xyz789");
    await addCommit(repo, "agent-work.txt", "agent work");
    await git(repo, "checkout", "main");
    await git(repo, "merge", "--squash", "worktree-agent-xyz789");
    await git(repo, "commit", "-m", "squash agent work");

    const { result } = await runAudit(repo);
    const categories = result.categories as Record<string, { name: string; proof: string }[]>;

    expect(categories.orphaned_worktree).toHaveLength(1);
    expect(categories.orphaned_worktree?.[0]?.name).toBe("worktree-agent-xyz789");
    expect(categories.orphaned_worktree?.[0]?.proof).toBe("no-merge-delta");
    expect(keptNames(result)).not.toContain("worktree-agent-xyz789");
  });

  test("detects backup branches", async () => {
    const repo = await makeRepo("backup");

    await git(repo, "checkout", "-b", "backup/some-work");
    await addCommit(repo, "backup.txt", "backup content");
    await git(repo, "checkout", "main");

    const { result } = await runAudit(repo);
    const categories = result.categories as Record<string, unknown[]>;

    expect(categories.backup).toHaveLength(1);
    expect((categories.backup?.[0] as { name: string } | undefined)?.name).toBe("backup/some-work");
    expect((categories.backup?.[0] as { ahead: number } | undefined)?.ahead).toBe(1);
  });

  test("detects squash-merged branches as content_merged", async () => {
    const repo = await makeRepo("squash");

    // Create feature branch with 2 commits
    await git(repo, "checkout", "-b", "feature/squashed");
    await addCommit(repo, "a.txt", "commit a");
    await addCommit(repo, "b.txt", "commit b");

    // Simulate squash-merge onto main
    await git(repo, "checkout", "main");
    await git(repo, "merge", "--squash", "feature/squashed");
    await git(repo, "commit", "-m", "squash merge feature");

    const { result } = await runAudit(repo);
    const categories = result.categories as Record<string, unknown[]>;

    expect(categories.content_merged).toHaveLength(1);
    expect((categories.content_merged?.[0] as { name: string } | undefined)?.name).toBe(
      "feature/squashed",
    );
    expect((categories.content_merged?.[0] as { proof: string } | undefined)?.proof).toBe(
      "no-merge-delta",
    );
  });

  test("does not claim containment for a squash that was later reverted", async () => {
    const repo = await makeRepo("squash-reverted");

    await git(repo, "checkout", "-b", "feature/undone");
    await addCommit(repo, "a.txt", "commit a");
    await addCommit(repo, "b.txt", "commit b");

    await git(repo, "checkout", "main");
    await git(repo, "merge", "--squash", "feature/undone");
    await git(repo, "commit", "-m", "squash merge feature");
    // The work is taken back out: base no longer holds the content.
    await git(repo, "revert", "--no-edit", "HEAD");

    const { result } = await runAudit(repo);
    const categories = result.categories as Record<string, unknown[]>;

    expect(categories.content_merged).toHaveLength(0);
    expect(keptEntry(result, "feature/undone")?.reason).toBe("unproven");
  });

  test("keeps current branch", async () => {
    const repo = await makeRepo("current");

    await git(repo, "checkout", "-b", "feature/active");
    await addCommit(repo, "active.txt", "active work");

    const { result } = await runAudit(repo);

    expect(keptNames(result)).toContain("feature/active");
    expect(keptEntry(result, "feature/active")?.reason).toBe("current");
  });

  test("keeps a branch whose worktree holds unmerged work, with the reason", async () => {
    const repo = await makeRepo("worktree-active");
    const wtDir = makeTmpDir("wt-active");

    await git(repo, "checkout", "-b", "feature/in-worktree");
    await addCommit(repo, "wt.txt", "worktree content");
    await git(repo, "checkout", "main");
    await git(repo, "worktree", "add", wtDir, "feature/in-worktree");

    const { result } = await runAudit(repo);

    expect(keptNames(result)).toContain("feature/in-worktree");
    const entry = keptEntry(result, "feature/in-worktree");
    expect(entry?.reason).toBe("worktree");
    expect(entry?.detail).toBe(wtDir);

    // Cleanup worktree
    await git(repo, "worktree", "remove", wtDir);
  });

  test("returns error for missing base branch", async () => {
    const repo = await makeRepo("no-base");

    const { exitCode, result } = await runAudit(repo, "--base", "nonexistent");
    expect(exitCode).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("nonexistent");
  });

  test("detects stale remote branches with --include-remote", async () => {
    const { repo } = await makeRepoWithOrigin("remote");

    // Create and push a feature branch
    await git(repo, "checkout", "-b", "feature/remote-done");
    await addCommit(repo, "remote.txt", "remote work");
    await git(repo, "push", "-u", "origin", "feature/remote-done");

    // Merge into main and push
    await git(repo, "checkout", "main");
    await git(repo, "merge", "feature/remote-done");
    await git(repo, "push", "origin", "main");

    // Delete local branch but leave remote
    await git(repo, "branch", "-d", "feature/remote-done");

    const { result } = await runAudit(repo, "--include-remote");
    const categories = result.categories as Record<string, unknown[]>;

    expect(categories.stale_remote).toHaveLength(1);
    expect((categories.stale_remote?.[0] as { name: string } | undefined)?.name).toBe(
      "origin/feature/remote-done",
    );
    expect((categories.stale_remote?.[0] as { proof: string } | undefined)?.proof).toBe("ancestry");
  });

  test("detects a squash-merged remote branch that ancestry alone would miss", async () => {
    const { repo } = await makeRepoWithOrigin("remote-squash");

    await git(repo, "checkout", "-b", "feature/remote-squashed");
    await addCommit(repo, "rs-a.txt", "remote squash a");
    await addCommit(repo, "rs-b.txt", "remote squash b");
    await git(repo, "push", "-u", "origin", "feature/remote-squashed");

    // Squash the work onto main: the remote branch is no ancestor of origin/main,
    // yet every file it carries is there.
    await git(repo, "checkout", "main");
    await git(repo, "merge", "--squash", "feature/remote-squashed");
    await git(repo, "commit", "-m", "squash remote feature");
    await git(repo, "push", "origin", "main");
    await git(repo, "branch", "-D", "feature/remote-squashed");

    const { result } = await runAudit(repo, "--include-remote");

    const stale = (result.categories as Record<string, { name: string; proof: string }[]>)
      .stale_remote;

    const entry = stale?.find((b) => b.name === "origin/feature/remote-squashed");
    expect(entry?.proof).toBe("no-merge-delta");
  });

  test("judges remote branches against origin/base, not a lagging local base", async () => {
    const { origin, repo } = await makeRepoWithOrigin("remote-base");
    const other = makeTmpDir("remote-base-clone");

    // A second clone merges the feature and pushes: origin/main now contains it,
    // local main in `repo` does not.
    await git(repo, "checkout", "-b", "feature/pushed-elsewhere");
    await addCommit(repo, "elsewhere.txt", "work done elsewhere");
    await git(repo, "push", "-u", "origin", "feature/pushed-elsewhere");
    await git(repo, "checkout", "main");
    await git(repo, "branch", "-D", "feature/pushed-elsewhere");

    await git(other, "clone", origin, other);
    await git(other, "config", "user.email", "test@test.com");
    await git(other, "config", "user.name", "Test");
    await git(other, "merge", "origin/feature/pushed-elsewhere");
    await git(other, "push", "origin", "main");

    const { result } = await runAudit(repo, "--include-remote");
    const categories = result.categories as Record<string, { name: string }[]>;

    expect(result.remote_base).toBe("origin/main");
    expect(categories.stale_remote?.map((b) => b.name)).toContain(
      "origin/feature/pushed-elsewhere",
    );
  });

  test("provides branch metadata (ahead, behind, date, subject)", async () => {
    const repo = await makeRepo("metadata");

    await git(repo, "checkout", "-b", "feature/meta");
    await addCommit(repo, "meta.txt", "Add metadata feature");
    await git(repo, "checkout", "main");
    await addCommit(repo, "main-advance.txt", "Advance main");

    const { result } = await runAudit(repo);

    // feature/meta is unmerged and its content is not on main, so it's kept
    expect(keptNames(result)).toContain("feature/meta");
    expect(keptEntry(result, "feature/meta")?.reason).toBe("unproven");
  });

  test("flags the -d refusal when the branch is ahead of its upstream", async () => {
    const { repo } = await makeRepoWithOrigin("d-refusal");

    await git(repo, "checkout", "-b", "feature/ahead-of-upstream");
    await addCommit(repo, "d.txt", "pushed work");
    await git(repo, "push", "-u", "origin", "feature/ahead-of-upstream");
    // Committed locally, never pushed: the tip is no longer in the upstream,
    // which is what makes `git branch -d` refuse even when main contains it.
    await addCommit(repo, "d2.txt", "unpushed work");

    await git(repo, "checkout", "main");
    await git(repo, "merge", "feature/ahead-of-upstream");

    const { result } = await runAudit(repo);

    const merged = (
      result.categories as Record<string, { name: string; d_refusal: string | null }[]>
    ).merged_local;

    const entry = merged?.find((b) => b.name === "feature/ahead-of-upstream");
    expect(entry).toBeDefined();
    expect(entry?.d_refusal).toBe("origin/feature/ahead-of-upstream");
  });

  test("leaves d_refusal null when the upstream still contains the branch", async () => {
    const { repo } = await makeRepoWithOrigin("d-no-refusal");

    await git(repo, "checkout", "-b", "feature/pushed");
    await addCommit(repo, "p.txt", "pushed work");
    await git(repo, "push", "-u", "origin", "feature/pushed");
    await git(repo, "checkout", "main");
    await git(repo, "merge", "feature/pushed");

    const { result } = await runAudit(repo);

    const merged = (
      result.categories as Record<string, { name: string; d_refusal: string | null }[]>
    ).merged_local;

    expect(merged?.find((b) => b.name === "feature/pushed")?.d_refusal).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Always-JSON contract
  // -------------------------------------------------------------------------

  test("emits valid error JSON when worktree listing fails", async () => {
    const repo = await makeRepo("worktree-fail");

    const { exitCode, result } = await runAuditWithFailingGit(repo, "worktree list");

    expect(exitCode).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.step).toBe("scan-worktrees");
    // Must be structured JSON, not an empty / non-JSON crash
    expect(typeof result.error).toBe("string");
  });

  // -------------------------------------------------------------------------
  // Remote: origin gate, non-destructive fetch, fail-closed
  // -------------------------------------------------------------------------

  test("skips remote scan (no network) when there is no origin", async () => {
    const repo = await makeRepo("no-origin");

    const { exitCode, result } = await runAudit(repo, "--include-remote");
    const categories = result.categories as Record<string, unknown[]>;

    expect(exitCode).toBe(0);
    expect(result.ok).toBe(true);
    expect(categories.stale_remote).toHaveLength(0);
    expect(categories.stale_tracking).toHaveLength(0);
  });

  test("fails closed (scan-remote) when origin exists but fetch fails", async () => {
    const { repo } = await makeRepoWithOrigin("fetch-fail");
    // Point origin at a path that does not exist -> fetch must fail
    await git(repo, "remote", "set-url", "origin", join(makeTmpDir("gone"), "missing.git"));

    const { exitCode, result } = await runAudit(repo, "--include-remote");

    expect(exitCode).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.step).toBe("scan-remote");
  });

  test("reports deleted upstream branch as stale_tracking, tracking ref intact", async () => {
    const { origin, repo } = await makeRepoWithOrigin("stale-tracking");

    await git(repo, "checkout", "-b", "feature/gone");
    await addCommit(repo, "gone.txt", "gone work");
    await git(repo, "push", "-u", "origin", "feature/gone");
    await git(repo, "checkout", "main");

    // Delete the branch directly on the remote (simulates someone else deleting it)
    await git(origin, "update-ref", "-d", "refs/heads/feature/gone");

    const { result } = await runAudit(repo, "--include-remote");
    const categories = result.categories as Record<string, unknown[]>;

    expect(categories.stale_tracking).toContain("origin/feature/gone");
    // Non-destructive audit: the tracking ref must still be present afterwards
    const remoteRefs = await git(repo, "branch", "-r", "--format=%(refname:short)");
    expect(remoteRefs.split("\n")).toContain("origin/feature/gone");
  });

  test("keeps a branch already deleted on origin out of stale_remote", async () => {
    const { origin, repo } = await makeRepoWithOrigin("remote-already-deleted");

    await git(repo, "checkout", "-b", "feature/done");
    await addCommit(repo, "done.txt", "work");
    await git(repo, "push", "-u", "origin", "feature/done");
    await git(repo, "checkout", "main");
    await git(repo, "merge", "feature/done");
    await git(repo, "push", "origin", "main");
    await git(repo, "branch", "-d", "feature/done");

    // Someone else deletes it on origin before the audit runs: the tracking ref
    // survives the --no-prune fetch, so ancestry would still prove containment.
    await git(origin, "update-ref", "-d", "refs/heads/feature/done");

    const { result } = await runAudit(repo, "--include-remote");
    const categories = result.categories as Record<string, unknown[]>;

    expect(categories.stale_tracking).toContain("origin/feature/done");
    expect((categories.stale_remote as { name: string }[]).map((b) => b.name)).not.toContain(
      "origin/feature/done",
    );
  });

  test("excludes non-origin remote branches from stale_remote", async () => {
    const { repo } = await makeRepoWithOrigin("multi-remote");
    const other = makeTmpDir("multi-remote-other");
    await git(other, "init", "--bare", "--initial-branch=main");
    await git(repo, "remote", "add", "other", other);

    await git(repo, "checkout", "-b", "feature/shared");
    await addCommit(repo, "shared.txt", "shared work");
    await git(repo, "push", "-u", "origin", "feature/shared");
    await git(repo, "push", "other", "feature/shared");

    await git(repo, "checkout", "main");
    await git(repo, "merge", "feature/shared");
    await git(repo, "push", "origin", "main");
    await git(repo, "branch", "-d", "feature/shared");
    await git(repo, "fetch", "other");

    const { result } = await runAudit(repo, "--include-remote");
    const stale = (result.categories as Record<string, { name: string }[]>).stale_remote;
    const names = stale?.map((b) => b.name);

    expect(names).toContain("origin/feature/shared");
    expect(names?.every((n) => n.startsWith("origin/"))).toBe(true);
    expect(names?.some((n) => n.startsWith("other/"))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Stale worktree branches flow into deletion classification
  // -------------------------------------------------------------------------

  test("classifies a stale-worktree branch in the same audit", async () => {
    const repo = await makeRepo("stale-wt-branch");
    const wtDir = makeTmpDir("stale-wt");

    await git(repo, "checkout", "-b", "feature/wt-stale");
    await addCommit(repo, "wt.txt", "worktree work");
    await git(repo, "checkout", "main");
    await git(repo, "merge", "feature/wt-stale");
    await git(repo, "worktree", "add", wtDir, "feature/wt-stale");

    // Remove the worktree directory out from under git: a stale registration.
    rmSync(wtDir, { recursive: true, force: true });

    const { result } = await runAudit(repo);
    const categories = result.categories as Record<string, { name?: string; path?: string }[]>;

    // Reported as a stale worktree...
    expect(categories.stale_worktrees?.some((w) => w.path === wtDir)).toBe(true);
    // ...AND its branch is classified for deletion instead of being retained.
    expect(categories.merged_local?.some((b) => b.name === "feature/wt-stale")).toBe(true);
    expect(keptNames(result)).not.toContain("feature/wt-stale");
  });

  describe("worktrees the audit leaves alone", () => {
    test("reports a locked detached worktree with its lock reason", async () => {
      const repo = await makeRepo("locked-detached");
      const wtDir = makeTmpDir("locked-detached-dir");

      await git(repo, "worktree", "add", "--detach", wtDir);
      await git(repo, "worktree", "lock", "--reason", "plugin catalog", wtDir);

      const { result } = await runAudit(repo);

      expect(worktreeCounts(result)).toEqual({ stale: 0, removable: 0, kept: 1 });
      expect(onlyKeptWorktree(result)).toMatchObject({
        branch: null,
        reason: "locked",
        detail: "lock reason: plugin catalog",
      });
    });

    test("keeps a locked worktree whose branch ref is gone", async () => {
      const repo = await makeRepo("locked-gone");
      const wtDir = makeTmpDir("locked-gone-dir");

      await git(repo, "worktree", "add", "-b", "feature/gone", wtDir);
      await git(repo, "worktree", "lock", wtDir);
      await git(repo, "update-ref", "-d", "refs/heads/feature/gone");

      const { result } = await runAudit(repo);

      expect(worktreeCounts(result)).toEqual({ stale: 0, removable: 0, kept: 1 });
      expect(onlyKeptWorktree(result)).toMatchObject({ branch: "feature/gone", reason: "locked" });
    });

    test("says a locked worktree lost its directory, and keeps its branch", async () => {
      const repo = await makeRepo("locked-missing");
      const wtDir = makeTmpDir("locked-missing-dir");

      await git(repo, "worktree", "add", "-b", "feature/locked-missing", wtDir);
      await git(repo, "worktree", "lock", wtDir);
      rmSync(wtDir, { recursive: true, force: true });

      const { result } = await runAudit(repo);
      const categories = result.categories as Record<string, { name?: string }[]>;

      expect(worktreeCounts(result)).toEqual({ stale: 0, removable: 0, kept: 1 });
      expect(onlyKeptWorktree(result)?.detail).toBe("directory missing");
      expect(categories.merged_local?.some((b) => b.name === "feature/locked-missing")).toBe(false);
      expect(keptEntry(result, "feature/locked-missing")?.reason).toBe("worktree");
    });

    test("keeps the contained branch of a live locked worktree", async () => {
      const repo = await makeRepo("locked-live");
      const wtDir = makeTmpDir("locked-live-dir");

      await git(repo, "worktree", "add", "-b", "feature/locked-live", wtDir);
      await git(repo, "worktree", "lock", "--reason", "in use", wtDir);

      const { result } = await runAudit(repo);
      const categories = result.categories as Record<string, { name?: string }[]>;

      expect(worktreeCounts(result)).toEqual({ stale: 0, removable: 0, kept: 1 });
      expect(categories.merged_local?.some((b) => b.name === "feature/locked-live")).toBe(false);
      expect(keptEntry(result, "feature/locked-live")?.reason).toBe("worktree");
    });

    test("keeps a prunable worktree whose directory is still on disk, and its branch", async () => {
      const repo = await makeRepo("prunable-present");
      const wtDir = makeTmpDir("prunable-present-dir");

      await git(repo, "worktree", "add", "-b", "feature/lost-link", wtDir);
      rmSync(join(wtDir, ".git"));

      const { result } = await runAudit(repo);
      const categories = result.categories as Record<string, { name?: string }[]>;

      expect(worktreeCounts(result)).toEqual({ stale: 0, removable: 0, kept: 1 });
      expect(onlyKeptWorktree(result)?.reason).toBe("prunable");
      expect(categories.merged_local?.some((b) => b.name === "feature/lost-link")).toBe(false);
      expect(keptEntry(result, "feature/lost-link")?.reason).toBe("worktree");
    });

    test("reports a worktree whose branch has no commit", async () => {
      const repo = await makeRepo("unborn");
      const wtDir = makeTmpDir("unborn-dir");

      await git(repo, "worktree", "add", "-b", "feature/gone", wtDir);
      await git(repo, "update-ref", "-d", "refs/heads/feature/gone");

      const { result } = await runAudit(repo);

      expect(worktreeCounts(result)).toEqual({ stale: 0, removable: 0, kept: 1 });
      expect(onlyKeptWorktree(result)).toMatchObject({ branch: "feature/gone", reason: "unborn" });
    });
  });

  describe("worktrees and the branches they stand on", () => {
    test("holds the branch of the main worktree when the audit runs from a linked one", async () => {
      const repo = await makeRepo("main-held");
      const wtDir = makeTmpDir("main-held-linked");

      await git(repo, "checkout", "-b", "feature/x");
      await addCommit(repo, "x.txt", "x work");
      await git(repo, "checkout", "main");
      await git(repo, "merge", "feature/x");
      await git(repo, "checkout", "feature/x");
      await git(repo, "worktree", "add", wtDir, "main");

      const { result } = await runAudit(wtDir);

      expect(categoryNames(result)).not.toContain("feature/x");
      expect(keptEntry(result, "feature/x")?.reason).toBe("worktree");
    });

    test("audits a bare repository", async () => {
      const repo = await makeRepo("bare-source");
      const bare = makeTmpDir("bare");

      await git(repo, "checkout", "-b", "feature/done");
      await addCommit(repo, "done.txt", "done work");
      await git(repo, "checkout", "main");
      await git(repo, "merge", "feature/done");
      await git(bare, "clone", "--bare", repo, ".");

      const { result } = await runAudit(bare);

      expect(result.ok).toBe(true);
      expect(categoryNames(result)).toContain("feature/done");
    });

    test("proves a branch in a clean worktree once, behind the age gate", async () => {
      const repo = await makeRepo("old-in-worktree");
      const wtDir = makeTmpDir("old-in-worktree-dir");

      await git(repo, "checkout", "-b", "feature/old");
      writeFileSync(join(repo, "old.txt"), "old work");
      await git(repo, "add", ".");
      await commitDaysAgo(repo, "old work", 400);
      await git(repo, "checkout", "main");
      await git(repo, "merge", "--squash", "feature/old");
      await git(repo, "commit", "-m", "squash of feature/old");
      await git(repo, "worktree", "add", wtDir, "feature/old");

      const { result } = await runAudit(repo);

      expect(worktreeCounts(result).removable).toBe(0);
      expect(keptEntry(result, "feature/old")?.reason).toBe("worktree");
    });

    test("reports a worktree whose HEAD git cannot resolve, and audits the rest", async () => {
      const repo = await makeRepo("corrupt-head");
      const wtDir = makeTmpDir("corrupt-head-dir");

      await git(repo, "worktree", "add", "-b", "feature/corrupt", wtDir);

      const adminDir = join(await git(repo, "rev-parse", "--git-common-dir"), "worktrees");

      const [name] = (await git(repo, "worktree", "list", "--porcelain"))
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .slice(1)
        .map((line) => line.split("/").pop());

      writeFileSync(join(repo, adminDir, name!, "HEAD"), "garbage\n");

      const { result } = await runAudit(repo);

      expect(result.ok).toBe(true);
      expect(onlyKeptWorktree(result)).toMatchObject({ reason: "unreadable", branch: null });
    });
  });

  describe("names git could resolve to another ref", () => {
    test("judges containment against the base branch, not a tag of the same name", async () => {
      const repo = await makeRepo("tag-like-base");

      await git(repo, "checkout", "-b", "feature/unmerged");
      await addCommit(repo, "work.txt", "unmerged work");
      await git(repo, "checkout", "main");
      await git(repo, "tag", "main", "feature/unmerged");

      const { result } = await runAudit(repo);

      expect(categoryNames(result)).not.toContain("feature/unmerged");
      expect(categoryNames(result)).not.toContain("heads/main");
      expect(keptEntry(result, "feature/unmerged")?.reason).toBe("unproven");
    });

    test("reports a branch under its own name and tip when a tag shares the name", async () => {
      const repo = await makeRepo("tag-like-branch");

      await git(repo, "checkout", "-b", "feature/x");
      await addCommit(repo, "x.txt", "x work");
      await git(repo, "checkout", "main");
      await git(repo, "merge", "feature/x");
      await git(repo, "tag", "feature/x", "main~1");

      const { result } = await runAudit(repo);

      const merged = (result.categories as Record<string, { name: string; oid: string }[]>)
        .merged_local;

      expect(merged?.map((b) => b.name)).toEqual(["feature/x"]);
      expect(merged?.[0]?.oid).toBe(await git(repo, "rev-parse", "refs/heads/feature/x"));
    });

    test("tests a branch rewritten recently even when its commit was authored long ago", async () => {
      const repo = await makeRepo("rebased-old");

      await git(repo, "checkout", "-b", "feature/rebased");
      writeFileSync(join(repo, "old.txt"), "old work");
      await git(repo, "add", ".");
      await git(repo, "commit", "-m", "old work", "--date=400 days ago");
      await git(repo, "checkout", "main");
      await git(repo, "merge", "--squash", "feature/rebased");
      await git(repo, "commit", "-m", "squash of feature/rebased");

      const { result } = await runAudit(repo);
      const content = (result.categories as Record<string, { name: string }[]>).content_merged;

      expect(content?.map((b) => b.name)).toContain("feature/rebased");
    });
  });

  // -------------------------------------------------------------------------
  // Live worktrees: releasable vs held
  // -------------------------------------------------------------------------

  test("proposes removing a live clean worktree whose branch is contained", async () => {
    const repo = await makeRepo("wt-removable");
    const wtDir = makeTmpDir("wt-removable-dir");

    await git(repo, "checkout", "-b", "feature/agent-done");
    await addCommit(repo, "agent.txt", "agent work");
    await git(repo, "checkout", "main");
    await git(repo, "merge", "feature/agent-done");
    await git(repo, "worktree", "add", wtDir, "feature/agent-done");

    const { result } = await runAudit(repo);

    const categories = result.categories as Record<
      string,
      { name?: string; path?: string; branch?: string; proof?: string }[]
    >;

    const removable = categories.removable_worktrees?.find((w) => w.path === wtDir);
    expect(removable?.branch).toBe("feature/agent-done");
    expect(removable?.proof).toBe("ancestry");
    // The branch must flow into deletion in the SAME pass, not sit in kept.
    expect(categories.merged_local?.some((b) => b.name === "feature/agent-done")).toBe(true);
    expect(keptNames(result)).not.toContain("feature/agent-done");

    await git(repo, "worktree", "remove", wtDir);
  });

  test("names the ignored files a worktree removal would destroy", async () => {
    const repo = await makeRepo("wt-ignored");
    const wtDir = makeTmpDir("wt-ignored-dir");

    writeFileSync(join(repo, ".gitignore"), ".env\nnode_modules/\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "add gitignore");
    await git(repo, "checkout", "-b", "feature/has-secrets");
    await addCommit(repo, "work.txt", "work");
    await git(repo, "checkout", "main");
    await git(repo, "merge", "feature/has-secrets");
    await git(repo, "worktree", "add", wtDir, "feature/has-secrets");

    // Untracked AND ignored: invisible to `git status --porcelain`, deleted
    // without complaint by `git worktree remove`.
    writeFileSync(join(wtDir, ".env"), "DB_PASSWORD=secret");
    mkdirSync(join(wtDir, "node_modules"), { recursive: true });
    writeFileSync(join(wtDir, "node_modules", "dep.js"), "module.exports = 1");

    const { result } = await runAudit(repo);

    const removable = (
      result.categories as Record<
        string,
        { path: string; ignored: { files: string[]; dirs: string[]; truncated: boolean } }[]
      >
    ).removable_worktrees?.find((w) => w.path === wtDir);

    // Still removable — but never silently: the cost is reported.
    expect(removable).toBeDefined();
    expect(removable?.ignored.files).toEqual([".env"]);
    expect(removable?.ignored.dirs).toEqual(["node_modules/"]);
    expect(removable?.ignored.truncated).toBe(false);

    await git(repo, "worktree", "remove", "--force", wtDir);
  });

  test("keeps an agent branch carrying unproven work instead of offering it", async () => {
    const repo = await makeRepo("agent-unproven");

    // The tool creates these and agents normally abandon them empty. This one
    // was worked on directly, so it holds the only copy of that commit.
    await git(repo, "checkout", "-b", "worktree-agent-abc123");
    await addCommit(repo, "only-copy.txt", "work that exists nowhere else");
    await git(repo, "checkout", "main");

    const { result } = await runAudit(repo);
    const categories = result.categories as Record<string, { name: string }[]>;

    expect(categories.orphaned_worktree).toHaveLength(0);
    expect(keptEntry(result, "worktree-agent-abc123")?.reason).toBe("unproven");
  });

  test("keeps a dirty worktree and says so", async () => {
    const repo = await makeRepo("wt-dirty");
    const wtDir = makeTmpDir("wt-dirty-dir");

    await git(repo, "checkout", "-b", "feature/agent-dirty");
    await addCommit(repo, "agent.txt", "agent work");
    await git(repo, "checkout", "main");
    await git(repo, "merge", "feature/agent-dirty");
    await git(repo, "worktree", "add", wtDir, "feature/agent-dirty");
    writeFileSync(join(wtDir, "uncommitted.txt"), "work in progress");

    const { result } = await runAudit(repo);
    const categories = result.categories as Record<string, { path?: string }[]>;

    expect(categories.removable_worktrees).toHaveLength(0);
    const entry = keptEntry(result, "feature/agent-dirty");
    expect(entry?.reason).toBe("dirty-worktree");
    expect(entry?.detail).toBe(wtDir);

    await git(repo, "worktree", "remove", "--force", wtDir);
  });

  // -------------------------------------------------------------------------
  // Trunk protection, base resolution, sweep.* config
  // -------------------------------------------------------------------------

  test("never proposes a protected trunk, local or remote", async () => {
    const { repo } = await makeRepoWithOrigin("protected-trunk");

    // dev is the working trunk: main is its ancestor by design, on both sides.
    await git(repo, "checkout", "-b", "dev");
    await addCommit(repo, "dev.txt", "dev work");
    await git(repo, "push", "-u", "origin", "dev");

    const { result } = await runAudit(repo, "--base", "dev", "--include-remote");
    const categories = result.categories as Record<string, { name: string }[]>;

    expect(categories.merged_local).toHaveLength(0);
    expect(categories.stale_remote).toHaveLength(0);
    expect(keptEntry(result, "main")?.reason).toBe("protected");
    const keptRemote = result.kept_remote as Kept[];
    expect(keptRemote.find((k) => k.name === "origin/main")?.reason).toBe("protected");
  });

  test("honours sweep.protect for a custom branch", async () => {
    const repo = await makeRepo("sweep-protect");

    await git(repo, "checkout", "-b", "release");
    await git(repo, "checkout", "main");
    await git(repo, "config", "sweep.protect", "release");

    const { result } = await runAudit(repo);
    const categories = result.categories as Record<string, unknown[]>;

    expect(categories.merged_local).toHaveLength(0);
    expect(keptEntry(result, "release")?.reason).toBe("protected");
  });

  test("resolves the base itself when none is given", async () => {
    const repo = await makeRepo("resolve-master");
    await git(repo, "branch", "-m", "main", "master");

    const { exitCode, result } = await runAudit(repo);

    expect(exitCode).toBe(0);
    expect(result.base).toBe("master");
  });

  test("skips a stale origin/HEAD candidate that no longer exists", async () => {
    const { repo } = await makeRepoWithOrigin("stale-origin-head");
    await git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/gone");

    const { exitCode, result } = await runAudit(repo);

    expect(exitCode).toBe(0);
    expect(result.base).toBe("main");
  });

  test("sweep.base wins over the default candidates", async () => {
    const repo = await makeRepo("sweep-base");
    await git(repo, "checkout", "-b", "work");
    await git(repo, "checkout", "main");
    await git(repo, "config", "sweep.base", "work");

    const { result } = await runAudit(repo);

    expect(result.base).toBe("work");
  });

  test("errors when no trunk candidate exists", async () => {
    const repo = await makeRepo("no-trunk");
    await git(repo, "branch", "-m", "main", "wip");

    const { exitCode, result } = await runAudit(repo);

    expect(exitCode).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no trunk branch found");
  });

  test("rejects an invalid --max-age instead of dropping the age gate", async () => {
    const repo = await makeRepo("bad-max-age");

    const { exitCode, result } = await runAudit(repo, "--max-age", "abc");

    expect(exitCode).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.step).toBe("validate");
  });

  test("honours custom prefixes from git config, replacing the defaults", async () => {
    const repo = await makeRepo("custom-prefixes");
    await git(repo, "config", "sweep.agentPrefix", "wt-");
    await git(repo, "config", "sweep.backupPrefix", "save/");

    await git(repo, "checkout", "-b", "wt-abc");
    await git(repo, "checkout", "-b", "save/old");
    await addCommit(repo, "save.txt", "saved work");
    await git(repo, "checkout", "main");
    // Carries the DEFAULT agent prefix: with a custom prefix set it must be
    // classified as an ordinary merged branch, not as an agent branch.
    await git(repo, "branch", "worktree-agent-old");

    const { result } = await runAudit(repo);
    const categories = result.categories as Record<string, { name: string }[]>;

    expect(categories.orphaned_worktree?.map((b) => b.name)).toEqual(["wt-abc"]);
    expect(categories.backup?.map((b) => b.name)).toContain("save/old");
    expect(categories.merged_local?.map((b) => b.name)).toEqual(["worktree-agent-old"]);
  });

  test("rejects overlapping agent and backup prefixes", async () => {
    const repo = await makeRepo("prefix-overlap");
    await git(repo, "config", "sweep.agentPrefix", "wt-agent-");
    await git(repo, "config", "sweep.backupPrefix", "wt-");

    const { exitCode, result } = await runAudit(repo);

    expect(exitCode).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.step).toBe("validate");
    expect(result.error).toContain("overlap");
  });

  test("errors when sweep.base names a missing branch instead of substituting", async () => {
    const repo = await makeRepo("sweep-base-missing");
    await git(repo, "config", "sweep.base", "gone");

    const { exitCode, result } = await runAudit(repo);

    expect(exitCode).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("sweep.base 'gone'");
  });

  test("rejects an explicit --base that is not a local branch", async () => {
    const repo = await makeRepo("base-not-branch");
    await git(repo, "tag", "v1");

    for (const target of ["HEAD", "v1"]) {
      const { exitCode, result } = await runAudit(repo, "--base", target);
      expect(exitCode).toBe(1);
      expect(result.error).toContain(`base branch '${target}' not found`);
    }
  });

  test("sweep.unprotect lifts a default so a dead trunk name can be swept", async () => {
    const repo = await makeRepo("unprotect");
    await git(repo, "branch", "master");

    const withDefault = await runAudit(repo);
    expect(keptEntry(withDefault.result, "master")?.reason).toBe("protected");

    await git(repo, "config", "sweep.unprotect", "master");
    const { result } = await runAudit(repo);
    const categories = result.categories as Record<string, { name: string }[]>;

    expect(categories.merged_local?.map((b) => b.name)).toContain("master");
    expect(keptNames(result)).not.toContain("master");
  });

  test("resolves develop when it is the only trunk candidate", async () => {
    const repo = await makeRepo("resolve-develop");
    await git(repo, "branch", "-m", "main", "develop");

    const { exitCode, result } = await runAudit(repo);

    expect(exitCode).toBe(0);
    expect(result.base).toBe("develop");
  });

  // -------------------------------------------------------------------------
  // Durable manifest hand-off (--save-manifest)
  // -------------------------------------------------------------------------

  test("--save-manifest writes {manifest, kept} atomically to the git dir", async () => {
    const repo = await makeRepo("save-manifest");

    const manifest = {
      base: "main",
      worktrees: [],
      stale_worktrees: [],
      branches: [{ name: "feature/x", force: false, oid: "a".repeat(40) }],
      remote_branches: [],
      prune_remotes: false,
    };

    const gitDir = await git(repo, "rev-parse", "--absolute-git-dir");

    const proc = Bun.spawn(["bun", "run", SCRIPT, "--save-manifest"], {
      cwd: repo,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    const kept = [{ name: "main", reason: "base", detail: null }];
    proc.stdin.write(JSON.stringify({ manifest, kept }));
    await proc.stdin.end();
    const out = JSON.parse((await new Response(proc.stdout).text()).trim());
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(out.ok).toBe(true);
    const saved = JSON.parse(await Bun.file(join(gitDir, "git-sweep-manifest.json")).text());
    expect(saved.manifest.branches[0].name).toBe("feature/x");
    expect(saved.kept).toEqual(kept);
  });

  test("--save-manifest rejects a branch entry with no audited oid", async () => {
    const repo = await makeRepo("save-manifest-no-oid");

    const proc = Bun.spawn(["bun", "run", SCRIPT, "--save-manifest"], {
      cwd: repo,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    proc.stdin.write(
      JSON.stringify({
        manifest: {
          base: "main",
          worktrees: [],
          stale_worktrees: [],
          branches: [{ name: "feature/x", force: false }],
          remote_branches: [],
          prune_remotes: false,
        },
        kept: [],
      }),
    );
    await proc.stdin.end();
    const out = JSON.parse((await new Response(proc.stdout).text()).trim());

    expect(await proc.exited).toBe(1);
    expect(out.ok).toBe(false);
  });

  test("--save-manifest rejects an invalid manifest shape", async () => {
    const repo = await makeRepo("save-manifest-bad");

    const proc = Bun.spawn(["bun", "run", SCRIPT, "--save-manifest"], {
      cwd: repo,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    proc.stdin.write(JSON.stringify({ manifest: { branches: "nope" }, kept: [] }));
    await proc.stdin.end();
    const out = JSON.parse((await new Response(proc.stdout).text()).trim());
    const exitCode = await proc.exited;

    expect(exitCode).toBe(1);
    expect(out.ok).toBe(false);
  });

  // -------------------------------------------------------------------------
  // merged-pr proof: GitHub answers what the local proofs cannot
  // -------------------------------------------------------------------------

  test("proves containment for a squash-merged branch the base later edited", async () => {
    const { repo } = await makeMergedThenEdited("gh-squash-edited", "squash");
    const tip = await git(repo, "rev-parse", MERGED_BRANCH);
    const landing = await git(repo, "rev-parse", "main~1");

    const { result } = await runAuditWithGh(
      repo,
      { nameWithOwner: "acme/repo", pulls: {}, merged: [listedPull(3, tip, landing)] },
      "--include-remote",
    );

    expect(provenEntry(result, "content_merged", MERGED_BRANCH)?.proof).toBe("merged-pr");
    expect(keptNames(result)).not.toContain(MERGED_BRANCH);
  });

  // No merged pull request carries the local name: only the lookup by tip finds it.
  test("proves containment for a rebase-merged branch renamed locally", async () => {
    const { repo } = await makeMergedThenEdited("gh-rebase-edited", "cherry-pick");
    await git(repo, "branch", "-m", MERGED_BRANCH, "local/renamed");
    const tip = await git(repo, "rev-parse", "local/renamed");
    const landing = await git(repo, "rev-parse", "main~1");

    const { result } = await runAuditWithGh(
      repo,
      { nameWithOwner: "acme/repo", pulls: { [tip]: [restPull(4, tip, landing)] }, merged: [] },
      "--include-remote",
    );

    expect(provenEntry(result, "content_merged", "local/renamed")?.proof).toBe("merged-pr");
  });

  test("proves containment for a branch behind the merged tip", async () => {
    const { repo } = await makeMergedThenEdited("gh-behind", "squash");
    const head = await git(repo, "rev-parse", MERGED_BRANCH);
    const landing = await git(repo, "rev-parse", "main~1");
    await git(repo, "branch", "-f", MERGED_BRANCH, `${MERGED_BRANCH}~1`);

    const { result } = await runAuditWithGh(
      repo,
      { nameWithOwner: "acme/repo", pulls: {}, merged: [listedPull(8, head, landing)] },
      "--include-remote",
    );

    expect(provenEntry(result, "content_merged", MERGED_BRANCH)?.proof).toBe("merged-pr");
  });

  test("proves containment for a branch whose remote counterpart is gone", async () => {
    const { origin, repo } = await makeBaseAndBranch("gh-remote-deleted");
    await git(repo, "push", "-u", "origin", MERGED_BRANCH);
    const landing = await squashMerge(repo);
    await commitFile(repo, "f.txt", MAIN_REWROTE, "main: rewrite A");
    await git(repo, "push", "origin", "main");
    await git(origin, "update-ref", "-d", `refs/heads/${MERGED_BRANCH}`);
    const tip = await git(repo, "rev-parse", MERGED_BRANCH);

    const { result } = await runAuditWithGh(
      repo,
      { nameWithOwner: "acme/repo", pulls: {}, merged: [listedPull(11, tip, landing)] },
      "--include-remote",
    );

    expect(provenEntry(result, "content_merged", MERGED_BRANCH)?.proof).toBe("merged-pr");
  });

  test("keeps a branch whose pull request was reverted on the base", async () => {
    const { repo } = await makeBaseAndBranch("gh-reverted");
    const squashSha = await squashMerge(repo);
    await git(repo, "revert", "--no-edit", "HEAD");
    await git(repo, "push", "origin", "main");
    const tip = await git(repo, "rev-parse", MERGED_BRANCH);

    const { result } = await runAuditWithGh(
      repo,
      {
        nameWithOwner: "acme/repo",
        pulls: { [squashSha]: [restPull(9, tip, squashSha)] },
        merged: [listedPull(9, tip, squashSha)],
      },
      "--include-remote",
    );

    expect(keptEntry(result, MERGED_BRANCH)?.reason).toBe("unproven");
  });

  test("keeps a branch whose pull request's landing commit is not in the base", async () => {
    const { repo } = await makeBaseAndBranch("gh-other-base");
    await git(repo, "checkout", "-b", "staging");
    const landing = await squashMerge(repo);
    await git(repo, "checkout", "main");
    const tip = await git(repo, "rev-parse", MERGED_BRANCH);

    const { result } = await runAuditWithGh(
      repo,
      { nameWithOwner: "acme/repo", pulls: {}, merged: [listedPull(10, tip, landing)] },
      "--include-remote",
    );

    expect(keptEntry(result, MERGED_BRANCH)?.reason).toBe("unproven");
  });

  // The upper pull request of a stack targets the lower branch, and its landing
  // commit lands there first: the base holds it only once the lower one lands.
  test("proves a stacked pull request once its landing commit reaches the base", async () => {
    const { repo } = await makeBaseAndBranch("gh-stack");
    const tip = await git(repo, "rev-parse", MERGED_BRANCH);
    await git(repo, "checkout", "-b", "feature/lower");
    const landing = await squashMerge(repo);
    await commitFile(repo, "f.txt", MAIN_REWROTE, "lower: rewrite A");
    await git(repo, "checkout", "main");

    const fixtures = {
      nameWithOwner: "acme/repo",
      pulls: {},
      merged: [listedPull(30, tip, landing)],
    };

    const before = await runAuditWithGh(repo, fixtures, "--include-remote");
    expect(keptEntry(before.result, MERGED_BRANCH)?.reason).toBe("unproven");

    await git(repo, "merge", "--ff-only", "feature/lower");
    const after = await runAuditWithGh(repo, fixtures, "--include-remote");

    expect(provenEntry(after.result, "content_merged", MERGED_BRANCH)?.proof).toBe("merged-pr");
  });

  test("keeps a branch with a commit added after its pull request merged, and names it", async () => {
    const { repo } = await makeBaseAndBranch("gh-pushed-after");
    const head = await git(repo, "rev-parse", MERGED_BRANCH);
    const landing = await squashMerge(repo);
    await git(repo, "push", "origin", "main");
    await git(repo, "checkout", MERGED_BRANCH);
    await commitFile(repo, "f.txt", `${WITH_AB}after merge C\n`, "feature: add C");
    await git(repo, "checkout", "main");

    const { result } = await runAuditWithGh(
      repo,
      { nameWithOwner: "acme/repo", pulls: {}, merged: [listedPull(12, head, landing)] },
      "--include-remote",
    );

    expect(keptEntry(result, MERGED_BRANCH)?.reason).toBe("unproven");
    expect(keptEntry(result, MERGED_BRANCH)?.detail).toMatch(
      /PR #12: 0\/1 commits match its head, 0 modified, 1 missing \([0-9a-f]+ feature: add C\)$/u,
    );
  });

  test("keeps a branch GitHub knows no merged pull request for, with no report", async () => {
    const { repo } = await makeBaseAndBranch("gh-unknown-tip");
    await squashMerge(repo);
    await git(repo, "push", "origin", "main");
    await git(repo, "checkout", MERGED_BRANCH);
    await commitFile(repo, "f.txt", `${WITH_AB}local only C\n`, "feature: add C");
    await git(repo, "checkout", "main");

    // No fixture for the tip: the shim exits 1, which is the HTTP 422 answer.
    const { result } = await runAuditWithGh(
      repo,
      { nameWithOwner: "acme/repo", pulls: {}, merged: [] },
      "--include-remote",
    );

    expect(keptEntry(result, MERGED_BRANCH)).toEqual({
      name: MERGED_BRANCH,
      reason: "unproven",
      detail: "3 commit(s) not proven to be in main",
    });
  });

  test("keeps a branch whose pull request is still open", async () => {
    const { repo } = await makeBaseAndBranch("gh-open-pr");
    await git(repo, "checkout", MERGED_BRANCH);
    await git(repo, "reset", "--hard", "main");
    await commitFile(repo, "open.txt", "work in progress\n", "feature: open work");
    await git(repo, "checkout", "main");
    const tip = await git(repo, "rev-parse", MERGED_BRANCH);

    const { result } = await runAuditWithGh(
      repo,
      { nameWithOwner: "acme/repo", pulls: { [tip]: [restPull(13, tip, null)] }, merged: [] },
      "--include-remote",
    );

    expect(keptEntry(result, MERGED_BRANCH)?.reason).toBe("unproven");
  });

  test("keeps a branch whose pull request was closed unmerged", async () => {
    const { repo } = await makeBaseAndBranch("gh-closed-unmerged");
    const tip = await git(repo, "rev-parse", MERGED_BRANCH);

    const { result } = await runAuditWithGh(
      repo,
      { nameWithOwner: "acme/repo", pulls: { [tip]: [] }, merged: [] },
      "--include-remote",
    );

    expect(keptEntry(result, MERGED_BRANCH)?.reason).toBe("unproven");
  });

  test("gives a remote branch the same merged-pr proof as its local twin", async () => {
    const { repo } = await makeBaseAndBranch("gh-remote-twin");
    await git(repo, "push", "-u", "origin", MERGED_BRANCH);
    const landing = await squashMerge(repo);
    await commitFile(repo, "f.txt", MAIN_REWROTE, "main: rewrite A");
    await git(repo, "push", "origin", "main");
    // Local tip and origin/<branch> are the same commit, under the same name.
    const tip = await git(repo, "rev-parse", MERGED_BRANCH);

    const { result } = await runAuditWithGh(
      repo,
      { nameWithOwner: "acme/repo", pulls: {}, merged: [listedPull(11, tip, landing)] },
      "--include-remote",
    );

    expect(provenEntry(result, "content_merged", MERGED_BRANCH)?.proof).toBe("merged-pr");
    expect(provenNames(result, "stale_remote")).toContain(`origin/${MERGED_BRANCH}`);
    expect(provenEntry(result, "stale_remote", `origin/${MERGED_BRANCH}`)?.proof).toBe("merged-pr");
  });

  describe("a branch rebased and landed from another checkout", () => {
    test("is proven when every local commit has its patch in the pull request's head", async () => {
      const { origin, repo } = await makeBaseAndBranch("gh-clean-rebase");

      const { head, landing } = await landElsewhere(origin, repo, 20, {
        landing: "fast-forward",
        resolveB: false,
      });

      const { result } = await runAuditWithGh(
        repo,
        { nameWithOwner: "acme/repo", pulls: {}, merged: [listedPull(20, head, landing)] },
        "--include-remote",
      );

      expect(provenEntry(result, "content_merged", MERGED_BRANCH)?.proof).toBe("merged-pr");
    });

    test("is kept once a commit was added after the landing, which the report names", async () => {
      const { origin, repo } = await makeBaseAndBranch("gh-rebase-then-commit");

      const { head, landing } = await landElsewhere(origin, repo, 20, {
        landing: "fast-forward",
        resolveB: false,
      });

      await git(repo, "checkout", MERGED_BRANCH);
      await commitFile(repo, "c.txt", "local C\n", "feature: add C");
      await git(repo, "checkout", "main");

      const { result } = await runAuditWithGh(
        repo,
        { nameWithOwner: "acme/repo", pulls: {}, merged: [listedPull(20, head, landing)] },
        "--include-remote",
      );

      expect(keptEntry(result, MERGED_BRANCH)?.reason).toBe("unproven");
      expect(keptEntry(result, MERGED_BRANCH)?.detail).toMatch(
        /; PR #20: 2\/3 commits match its head, 0 modified, 1 missing \([0-9a-f]+ feature: add C\)$/u,
      );
    });

    test("is proven after a conflict when the local tip is a former head", async () => {
      const { origin, repo } = await makeBaseAndBranch("gh-conflict-former-head");
      const tip = await git(repo, "rev-parse", MERGED_BRANCH);

      const { head, landing } = await landElsewhere(origin, repo, 21, {
        landing: "squash",
        resolveB: true,
      });

      const { result } = await runAuditWithGh(
        repo,
        {
          nameWithOwner: "acme/repo",
          pulls: {},
          merged: [listedPull(21, head, landing)],
          forcePushes: { 21: [tip] },
        },
        "--include-remote",
      );

      expect(provenEntry(result, "content_merged", MERGED_BRANCH)?.proof).toBe("merged-pr");
    });

    test("is kept after a conflict when the local tip was never a head", async () => {
      const { origin, repo } = await makeBaseAndBranch("gh-conflict-never-head");

      const { head, landing } = await landElsewhere(origin, repo, 21, {
        landing: "squash",
        resolveB: true,
      });

      const { result } = await runAuditWithGh(
        repo,
        {
          nameWithOwner: "acme/repo",
          pulls: {},
          merged: [listedPull(21, head, landing)],
          forcePushes: { 21: [] },
        },
        "--include-remote",
      );

      expect(keptEntry(result, MERGED_BRANCH)?.reason).toBe("unproven");
      expect(keptEntry(result, MERGED_BRANCH)?.detail).toMatch(
        /; PR #21: 1\/2 commits match its head, 1 modified \([0-9a-f]+ feature: add B\), 0 missing$/u,
      );
    });

    test("is kept when the former head holds a commit the pull request dropped", async () => {
      const { origin, repo } = await makeBaseAndBranch("gh-dropped-commit");
      await git(repo, "checkout", MERGED_BRANCH);
      await commitFile(repo, "x.txt", "dropped\n", "feature: add X");
      await git(repo, "checkout", "main");
      const tip = await git(repo, "rev-parse", MERGED_BRANCH);

      const { head, landing } = await landElsewhere(origin, repo, 22, {
        landing: "squash",
        resolveB: false,
      });

      const { result } = await runAuditWithGh(
        repo,
        {
          nameWithOwner: "acme/repo",
          pulls: {},
          merged: [listedPull(22, head, landing)],
          forcePushes: { 22: [tip] },
        },
        "--include-remote",
      );

      expect(keptEntry(result, MERGED_BRANCH)?.reason).toBe("unproven");
      expect(keptEntry(result, MERGED_BRANCH)?.detail).toMatch(
        /1 missing \([0-9a-f]+ feature: add X\)$/u,
      );
    });
  });

  test("keeps today's verdicts with no gh, a failing gh, or a repo that is not on GitHub", async () => {
    const { repo } = await makeMergedThenEdited("gh-absent", "squash");
    const tip = await git(repo, "rev-parse", MERGED_BRANCH);
    const winning = [listedPull(3, tip, await git(repo, "rev-parse", "main~1"))];

    const noBinary = await runAuditWithGh(repo, null, "--include-remote");
    expect(keptEntry(noBinary.result, MERGED_BRANCH)?.reason).toBe("unproven");

    const noRepoView = await runAuditWithGh(
      repo,
      { nameWithOwner: null, pulls: {} },
      "--include-remote",
    );

    expect(keptEntry(noRepoView.result, MERGED_BRANCH)?.reason).toBe("unproven");

    // The repo probe alone gates the proof: winning pull data never gets read.
    const notOnGithub = await runAuditWithGh(
      repo,
      { nameWithOwner: null, pulls: {}, merged: winning },
      "--include-remote",
    );

    expect(keptEntry(notOnGithub.result, MERGED_BRANCH)?.reason).toBe("unproven");
  });

  test("makes no GitHub call without --include-remote", async () => {
    const { repo } = await makeMergedThenEdited("gh-opt-in", "squash");
    const tip = await git(repo, "rev-parse", MERGED_BRANCH);

    const { result } = await runAuditWithGh(repo, {
      nameWithOwner: "acme/repo",
      pulls: {},
      merged: [listedPull(3, tip, await git(repo, "rev-parse", "main~1"))],
    });

    expect(keptEntry(result, MERGED_BRANCH)?.reason).toBe("unproven");
  });
});
