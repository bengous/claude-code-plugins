/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- this harness asserts on the JSON that rebase.ts prints on stdout: closed types, or a safety comment per read, would assert the schema instead of the behaviour, and a wrong shape has to fail an assertion rather than the compiler. */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

const SCRIPT = join(import.meta.dir, "rebase.ts");

let tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `rebase-test-${prefix}-`));
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
  const { stdout, stderr, exitCode } = await $`git ${args}`.cwd(cwd).quiet().nothrow();
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${exitCode}): ${stderr.toString().trim()}`);
  }
  return stdout.toString().trim();
}

async function run(
  cwd: string,
  args: string[],
  stdin: string | null = null,
): Promise<{ exitCode: number; result: Record<string, unknown> }> {
  const shell =
    stdin === null
      ? $`bun run ${SCRIPT} ${args}`
      : $`bun run ${SCRIPT} ${args} < ${Buffer.from(stdin)}`;
  const { stdout, exitCode } = await shell.cwd(cwd).quiet().nothrow();
  const out = stdout.toString().trim();
  try {
    return { exitCode, result: JSON.parse(out) };
  } catch {
    return { exitCode, result: { ok: false, error: `parse-error: ${out}` } };
  }
}

/** A repo on `main` whose commits are the given subjects, each touching its own file. */
async function makeRepo(prefix: string, subjects: string[]): Promise<string> {
  const repo = makeTmpDir(prefix);
  await git(repo, "init", "--initial-branch=main");
  await git(repo, "config", "user.email", "test@test.com");
  await git(repo, "config", "user.name", "Test");
  await git(repo, "config", "commit.gpgsign", "false");
  for (const [index, subject] of subjects.entries()) {
    await Bun.write(join(repo, `file-${index}.txt`), `${subject}\n`);
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", subject);
  }
  return repo;
}

async function hashes(repo: string, count: number): Promise<string[]> {
  const listed = await git(repo, "log", "--reverse", "--format=%H", `-${count}`);
  return listed.split("\n").filter(Boolean);
}

async function logSubjects(repo: string): Promise<string[]> {
  const listed = await git(repo, "log", "--format=%s");
  return listed.split("\n").filter(Boolean);
}

function step(hash: string, action: string, message: string | null = null) {
  return { hash, action, message };
}

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

describe("plan", () => {
  test("refuses to run outside a git repository", async () => {
    const dir = makeTmpDir("no-repo");
    const { exitCode, result } = await run(dir, ["plan", "1"]);
    expect(exitCode).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("not-a-git-repo");
  });

  test("refuses a dirty working directory", async () => {
    const repo = await makeRepo("dirty", ["initial commit", "second"]);
    await Bun.write(join(repo, "file-0.txt"), "edited\n");

    const { exitCode, result } = await run(repo, ["plan", "1"]);
    expect(exitCode).toBe(1);
    expect(result.error).toBe("dirty-worktree");
    expect(result.detail).toContain("file-0.txt");
  });

  test("lists the last N commits oldest first with their stats", async () => {
    const repo = await makeRepo("count", ["initial commit", "feat: parser", "fix: typo"]);

    const { exitCode, result } = await run(repo, ["plan", "2"]);
    expect(exitCode).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.branch).toBe("main");
    expect(result.base_short).toBe(await git(repo, "rev-parse", "--short", "HEAD~2"));

    const commits = result.commits as Record<string, unknown>[];
    expect(commits.map((commit) => commit.subject)).toEqual(["feat: parser", "fix: typo"]);
    expect(commits[0]?.files).toBe(1);
    expect(commits[0]?.insertions).toBe(1);
    expect(commits[0]?.deletions).toBe(0);
    expect(commits[0]?.author).toBe("Test");
  });

  test("keeps the body of a commit message", async () => {
    const repo = await makeRepo("body", ["initial commit"]);
    await Bun.write(join(repo, "extra.txt"), "extra\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "feat: subject", "-m", "The body explains why.");

    const { result } = await run(repo, ["plan", "1"]);
    const commits = result.commits as Record<string, unknown>[];
    expect(commits[0]?.subject).toBe("feat: subject");
    expect(commits[0]?.body).toBe("The body explains why.");
  });

  test("takes the merge base when given a branch", async () => {
    const repo = await makeRepo("branch", ["initial commit", "second"]);
    const mergeBase = await git(repo, "rev-parse", "HEAD");
    await git(repo, "checkout", "-b", "feature");
    await Bun.write(join(repo, "feature.txt"), "work\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "feat: the feature");

    const { result } = await run(repo, ["plan", "main"]);
    expect(result.base).toBe(mergeBase);
    expect((result.commits as unknown[]).length).toBe(1);
  });

  test("reports an empty range rather than failing", async () => {
    const repo = await makeRepo("empty", ["initial commit"]);
    const { exitCode, result } = await run(repo, ["plan", "0"]);
    expect(exitCode).toBe(0);
    expect(result.commits).toEqual([]);
  });

  test("rejects a revision that does not exist", async () => {
    const repo = await makeRepo("unknown", ["initial commit"]);
    const { exitCode, result } = await run(repo, ["plan", "no-such-ref"]);
    expect(exitCode).toBe(1);
    expect(result.error).toBe("invalid-range");
    expect(result.detail).toContain("no-such-ref");
  });

  test("rejects a count deeper than the history", async () => {
    const repo = await makeRepo("too-deep", ["initial commit"]);
    const { result } = await run(repo, ["plan", "99"]);
    expect(result.error).toBe("invalid-range");
    expect(result.detail).toContain("fewer than 99");
  });

  test("warns that an X..Y range still rewrites through HEAD", async () => {
    const repo = await makeRepo("range", ["initial commit", "a", "b", "c"]);
    const { result } = await run(repo, ["plan", "HEAD~3..HEAD~1"]);
    expect(result.base).toBe(await git(repo, "rev-parse", "HEAD~3"));
    expect(result.note).toContain("HEAD");
    expect((result.commits as unknown[]).length).toBe(3);
  });

  test("refuses while a rebase is in progress", async () => {
    const repo = await makeRepo("busy", ["initial commit", "A: one"]);
    await Bun.write(join(repo, "f.txt"), "one\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "B: two");
    await Bun.write(join(repo, "f.txt"), "three\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "C: three");

    const list = await hashes(repo, 3);
    const plan = {
      base: await git(repo, "rev-parse", "HEAD~3"),
      steps: [
        step(list[0] ?? "", "pick"),
        step(list[1] ?? "", "drop"),
        step(list[2] ?? "", "pick"),
      ],
    };
    await run(repo, ["apply"], JSON.stringify(plan));

    const { result } = await run(repo, ["plan", "1"]);
    expect(result.error).toBe("rebase-already-in-progress");
  });
});

// ---------------------------------------------------------------------------
// apply — validation
// ---------------------------------------------------------------------------

describe("apply validation", () => {
  test("rejects a plan that is not valid JSON", async () => {
    const repo = await makeRepo("bad-json", ["initial commit", "second"]);
    const { exitCode, result } = await run(repo, ["apply"], "not json");
    expect(exitCode).toBe(1);
    expect(result.error).toBe("invalid-plan");
  });

  test("rejects an unknown action", async () => {
    const repo = await makeRepo("bad-action", ["initial commit", "second"]);
    const list = await hashes(repo, 1);
    const plan = {
      base: await git(repo, "rev-parse", "HEAD~1"),
      steps: [step(list[0] ?? "", "explode")],
    };
    const { result } = await run(repo, ["apply"], JSON.stringify(plan));
    expect(result.error).toBe("invalid-plan");
    expect(result.detail).toContain("action");
  });

  test("rejects a plan whose commits moved under it", async () => {
    const repo = await makeRepo("stale", ["initial commit", "second"]);
    const base = await git(repo, "rev-parse", "HEAD~1");
    const list = await hashes(repo, 1);
    const plan = { base, steps: [step(list[0] ?? "", "pick")] };

    await Bun.write(join(repo, "late.txt"), "late\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "a commit the plan never saw");

    const { exitCode, result } = await run(repo, ["apply"], JSON.stringify(plan));
    expect(exitCode).toBe(1);
    expect(result.error).toBe("plan-stale");
  });

  test("rejects squashing the first commit that is kept", async () => {
    const repo = await makeRepo("squash-first", ["initial commit", "a", "b"]);
    const list = await hashes(repo, 2);
    const plan = {
      base: await git(repo, "rev-parse", "HEAD~2"),
      steps: [step(list[0] ?? "", "squash"), step(list[1] ?? "", "pick")],
    };
    const { result } = await run(repo, ["apply"], JSON.stringify(plan));
    expect(result.error).toBe("plan-invalid");
    expect(result.detail).toContain("cannot be squashed");
  });

  test("rejects a reword with no message", async () => {
    const repo = await makeRepo("empty-reword", ["initial commit", "a"]);
    const list = await hashes(repo, 1);
    const plan = {
      base: await git(repo, "rev-parse", "HEAD~1"),
      steps: [step(list[0] ?? "", "reword")],
    };
    const { result } = await run(repo, ["apply"], JSON.stringify(plan));
    expect(result.error).toBe("plan-invalid");
    expect(result.detail).toContain("rewords without a message");
  });

  test("rejects a message on a pick", async () => {
    const repo = await makeRepo("pick-message", ["initial commit", "a"]);
    const list = await hashes(repo, 1);
    const plan = {
      base: await git(repo, "rev-parse", "HEAD~1"),
      steps: [step(list[0] ?? "", "pick", "a message that would be ignored")],
    };
    const { result } = await run(repo, ["apply"], JSON.stringify(plan));
    expect(result.error).toBe("plan-invalid");
    expect(result.detail).toContain("carries a message");
  });

  test("accepts an abbreviated hash instead of calling the plan stale", async () => {
    const repo = await makeRepo("short-hash", ["initial commit", "a"]);
    const list = await hashes(repo, 1);
    const plan = {
      base: await git(repo, "rev-parse", "HEAD~1"),
      steps: [step((list[0] ?? "").slice(0, 8), "reword", "feat: a")],
    };
    const { exitCode, result } = await run(repo, ["apply"], JSON.stringify(plan));
    expect(exitCode).toBe(0);
    expect(result.step).toBe("applied");
    expect(await logSubjects(repo)).toEqual(["feat: a", "initial commit"]);
  });

  test("refuses a base that HEAD does not descend from", async () => {
    // Regression: `base: main` after main advanced turned the rebase into a
    // transplant onto main, while the plan still read as a list of picks.
    const repo = await makeRepo("transplant", ["initial commit"]);
    await git(repo, "checkout", "-b", "feature");
    await Bun.write(join(repo, "feature.txt"), "work\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "feat: the feature");
    const forked = await git(repo, "rev-parse", "HEAD");

    await git(repo, "checkout", "main");
    await Bun.write(join(repo, "moved.txt"), "moved\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "chore: main moved on");
    await git(repo, "checkout", "feature");

    const list = await hashes(repo, 1);
    const plan = { base: "main", steps: [step(list[0] ?? "", "pick")] };

    const { exitCode, result } = await run(repo, ["apply"], JSON.stringify(plan));
    expect(exitCode).toBe(1);
    expect(result.error).toBe("base-not-ancestor");
    expect(await git(repo, "rev-parse", "HEAD")).toBe(forked);
    expect(await git(repo, "branch", "--list")).not.toContain("rebase-backup");
  });

  test("accepts untracked files, which git rebase accepts too", async () => {
    const repo = await makeRepo("untracked", ["initial commit", "a"]);
    await Bun.write(join(repo, "scratch.json"), "{}\n");
    const list = await hashes(repo, 1);
    const plan = {
      base: await git(repo, "rev-parse", "HEAD~1"),
      steps: [step(list[0] ?? "", "reword", "feat: a")],
    };
    const { exitCode, result } = await run(repo, ["apply"], JSON.stringify(plan));
    expect(exitCode).toBe(0);
    expect(result.step).toBe("applied");
    expect(await Bun.file(join(repo, "scratch.json")).exists()).toBe(true);
  });

  test("still refuses a tracked file with uncommitted changes", async () => {
    const repo = await makeRepo("tracked-dirty", ["initial commit", "a"]);
    await Bun.write(join(repo, "file-0.txt"), "edited\n");
    const list = await hashes(repo, 1);
    const plan = {
      base: await git(repo, "rev-parse", "HEAD~1"),
      steps: [step(list[0] ?? "", "pick")],
    };
    const { result } = await run(repo, ["apply"], JSON.stringify(plan));
    expect(result.error).toBe("dirty-worktree");
    expect(result.detail).toContain("file-0.txt");
  });
});

// ---------------------------------------------------------------------------
// apply — execution
// ---------------------------------------------------------------------------

describe("apply", () => {
  test("--dry-run renders the plan and rewrites nothing", async () => {
    const repo = await makeRepo("dry-run", ["initial commit", "feat: parser", "fix: typo"]);
    const head = await git(repo, "rev-parse", "HEAD");
    const list = await hashes(repo, 2);
    const plan = {
      base: await git(repo, "rev-parse", "HEAD~2"),
      steps: [
        step(list[0] ?? "", "reword", "feat(parser): add the parser"),
        step(list[1] ?? "", "drop"),
      ],
    };

    const { exitCode, result } = await run(repo, ["apply", "--dry-run"], JSON.stringify(plan));
    expect(exitCode).toBe(0);
    expect(result.step).toBe("dry-run");

    const text = result.plan_text as string;
    expect(text).toContain("REWORD");
    expect(text).toContain("DROP");
    expect(text).toContain("feat(parser): add the parser");
    expect(text).toContain("Summary: 0 pick, 0 squash, 1 reword, 1 drop");

    expect(await git(repo, "rev-parse", "HEAD")).toBe(head);
    expect(await git(repo, "branch", "--list")).not.toContain("rebase-backup");
  });

  test("rewords, squashes and drops in one pass, behind a backup branch", async () => {
    const repo = await makeRepo("execute", ["initial commit", "feat: parser", "fix typo", "wip"]);
    const before = await git(repo, "rev-parse", "HEAD");
    const list = await hashes(repo, 3);
    const plan = {
      base: await git(repo, "rev-parse", "HEAD~3"),
      steps: [
        step(list[0] ?? "", "reword", "feat(parser): add the parser"),
        step(list[1] ?? "", "squash", "feat(parser): add the parser\n\nFolds the typo fix in."),
        step(list[2] ?? "", "drop"),
      ],
    };

    const { exitCode, result } = await run(repo, ["apply"], JSON.stringify(plan));
    expect(exitCode).toBe(0);
    expect(result.step).toBe("applied");
    expect(result.commits).toBe(1);

    expect(await logSubjects(repo)).toEqual(["feat(parser): add the parser", "initial commit"]);
    expect(await git(repo, "log", "-1", "--format=%b")).toBe("Folds the typo fix in.");

    const backup = result.backup_ref as string;
    expect(backup).toStartWith("rebase-backup-main-");
    expect(await git(repo, "rev-parse", backup)).toBe(before);
  });

  test("keeps every commit when the plan is all picks", async () => {
    const repo = await makeRepo("all-picks", ["initial commit", "a", "b"]);
    const list = await hashes(repo, 2);
    const plan = {
      base: await git(repo, "rev-parse", "HEAD~2"),
      steps: [step(list[0] ?? "", "pick"), step(list[1] ?? "", "pick")],
    };

    const { result } = await run(repo, ["apply"], JSON.stringify(plan));
    expect(result.step).toBe("applied");
    expect(await logSubjects(repo)).toEqual(["b", "a", "initial commit"]);
  });

  test("leaves no state directory behind on success", async () => {
    const repo = await makeRepo("cleanup", ["initial commit", "a"]);
    const list = await hashes(repo, 1);
    const plan = {
      base: await git(repo, "rev-parse", "HEAD~1"),
      steps: [step(list[0] ?? "", "reword", "feat: a")],
    };
    await run(repo, ["apply"], JSON.stringify(plan));
    expect(await Bun.file(join(repo, ".git", "claude-rebase", "todo")).exists()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

/** A repo where dropping the middle commit makes the last one conflict. */
async function makeConflictRepo(prefix: string): Promise<string> {
  const repo = await makeRepo(prefix, ["initial commit"]);
  for (const [subject, contents] of [
    ["A: one", "one"],
    ["B: two", "two"],
    ["C: three", "three"],
  ] as const) {
    await Bun.write(join(repo, "f.txt"), `${contents}\n`);
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", subject);
  }
  return repo;
}

async function startConflict(repo: string): Promise<Record<string, unknown>> {
  const list = await hashes(repo, 3);
  const plan = {
    base: await git(repo, "rev-parse", "HEAD~3"),
    steps: [step(list[0] ?? "", "pick"), step(list[1] ?? "", "drop"), step(list[2] ?? "", "pick")],
  };
  const { result } = await run(repo, ["apply"], JSON.stringify(plan));
  return result;
}

describe("conflicts", () => {
  test("reports the conflicted files and how to resolve them", async () => {
    const repo = await makeConflictRepo("conflict");
    const result = await startConflict(repo);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("conflict");

    const state = result.state as Record<string, unknown>;
    expect(state.in_progress).toBe(true);
    expect(state.total).toBe(3);
    const conflicted = state.conflicted as Record<string, unknown>[];
    expect(conflicted.map((file) => file.path)).toEqual(["f.txt"]);
    expect(conflicted[0]?.markers).toBe(1);

    expect((result.guidance as string[]).join(" ")).toContain("/rebase continue");
  });

  test("status reports the paused rebase, then reports none once aborted", async () => {
    const repo = await makeConflictRepo("status");
    await startConflict(repo);

    const paused = await run(repo, ["status"]);
    expect((paused.result.state as Record<string, unknown>).in_progress).toBe(true);

    const aborted = await run(repo, ["abort"]);
    expect(aborted.result.step).toBe("aborted");
    expect(await logSubjects(repo)).toEqual(["C: three", "B: two", "A: one", "initial commit"]);

    const clean = await run(repo, ["status"]);
    expect((clean.result.state as Record<string, unknown>).in_progress).toBe(false);
  });

  test("continue refuses while the conflict is unresolved, then finishes the rebase", async () => {
    const repo = await makeConflictRepo("continue");
    await startConflict(repo);

    const refused = await run(repo, ["continue"]);
    expect(refused.exitCode).toBe(1);
    expect(refused.result.error).toBe("unresolved-conflicts");

    await Bun.write(join(repo, "f.txt"), "three\n");
    await git(repo, "add", "f.txt");

    const finished = await run(repo, ["continue"]);
    expect(finished.exitCode).toBe(0);
    expect(finished.result.step).toBe("completed");
    expect(await logSubjects(repo)).toEqual(["C: three", "A: one", "initial commit"]);
  });

  test("continue refuses a staged file that still holds conflict markers", async () => {
    const repo = await makeConflictRepo("markers");
    await startConflict(repo);

    await git(repo, "add", "f.txt");

    const { result } = await run(repo, ["continue"]);
    expect(result.error).toBe("conflict-markers-staged");
    expect(result.detail).toBe("f.txt");
  });

  test("skip drops the conflicting commit", async () => {
    const repo = await makeConflictRepo("skip");
    await startConflict(repo);

    const { exitCode, result } = await run(repo, ["skip"]);
    expect(exitCode).toBe(0);
    expect(result.step).toBe("completed");
    expect(await logSubjects(repo)).toEqual(["A: one", "initial commit"]);
  });

  test("reports the conflict backup ref, and carries it through continue", async () => {
    const repo = await makeConflictRepo("backup-ref");
    const paused = await startConflict(repo);
    const backup = paused.backup_ref as string;
    expect(backup).toStartWith("rebase-backup-main-");

    await Bun.write(join(repo, "f.txt"), "three\n");
    await git(repo, "add", "f.txt");

    const { result } = await run(repo, ["continue"]);
    expect(result.step).toBe("completed");
    expect(result.backup_ref).toBe(backup);
  });

  test("continue and abort refuse when no rebase is running", async () => {
    const repo = await makeRepo("idle", ["initial commit"]);
    expect((await run(repo, ["continue"])).result.error).toBe("no-rebase-in-progress");
    expect((await run(repo, ["abort"])).result.error).toBe("no-rebase-in-progress");
  });
});

// ---------------------------------------------------------------------------
// A message that cannot be applied
// ---------------------------------------------------------------------------

/** A repo whose commit-msg hook rejects any subject that is not conventional. */
async function makePickyRepo(prefix: string): Promise<string> {
  const repo = await makeRepo(prefix, ["initial commit", "old subject"]);
  const hook = join(repo, ".git", "hooks", "commit-msg");
  await Bun.write(hook, '#!/bin/sh\ngrep -q "^feat" "$1" || { echo "hook: refused"; exit 1; }\n');
  await $`chmod +x ${hook}`.quiet();
  return repo;
}

async function startRejectedReword(repo: string): Promise<Record<string, unknown>> {
  const list = await hashes(repo, 1);
  const plan = {
    base: await git(repo, "rev-parse", "HEAD~1"),
    steps: [step(list[0] ?? "", "reword", "chore: the hook rejects this")],
  };
  const { result } = await run(repo, ["apply"], JSON.stringify(plan));
  return result;
}

describe("failed exec", () => {
  test("is reported as exec-failed with git's stderr, never as a conflict", async () => {
    // Regression: the state was read before the exit code, so a rejected amend
    // came back as "conflict" with an empty file list and git's stderr dropped.
    const repo = await makePickyRepo("exec-apply");
    const result = await startRejectedReword(repo);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("exec-failed");
    expect(result.detail).toContain("hook: refused");
    expect(result.detail).toContain("/rebase abort");
    expect(result.backup_ref).toStartWith("rebase-backup-main-");

    const state = result.state as Record<string, unknown>;
    expect(state.in_progress).toBe(true);
    expect(state.conflicted).toEqual([]);
  });

  test("continue refuses instead of finishing without the message", async () => {
    // Regression: continue returned "completed" while the reword was silently
    // skipped, because git does not replay a failed exec.
    const repo = await makePickyRepo("exec-continue");
    await startRejectedReword(repo);

    const { exitCode, result } = await run(repo, ["continue"]);
    expect(exitCode).toBe(1);
    expect(result.error).toBe("exec-failed");
    expect(result.step).toBe("continue");
    expect(await git(repo, "log", "-1", "--format=%s")).not.toBe("chore: the hook rejects this");
  });

  test("skip refuses too, for the same reason", async () => {
    const repo = await makePickyRepo("exec-skip");
    await startRejectedReword(repo);

    const { exitCode, result } = await run(repo, ["skip"]);
    expect(exitCode).toBe(1);
    expect(result.error).toBe("exec-failed");
  });

  test("abort undoes it and reports the backup ref", async () => {
    const repo = await makePickyRepo("exec-abort");
    const failure = await startRejectedReword(repo);

    const { result } = await run(repo, ["abort"]);
    expect(result.step).toBe("aborted");
    expect(result.backup_ref).toBe(failure.backup_ref);
    expect(await logSubjects(repo)).toEqual(["old subject", "initial commit"]);
  });
});

// ---------------------------------------------------------------------------
// Command routing
// ---------------------------------------------------------------------------

describe("routing", () => {
  test("prints usage with no arguments", async () => {
    const repo = await makeRepo("usage", ["initial commit"]);
    const { exitCode, result } = await run(repo, []);
    expect(exitCode).toBe(0);
    expect(result.step).toBe("usage");
    expect(result.usage).toContain("/rebase <branch|N|X..Y>");
  });

  test("rejects an unknown mode", async () => {
    const repo = await makeRepo("unknown-mode", ["initial commit"]);
    const { exitCode, result } = await run(repo, ["frobnicate"]);
    expect(exitCode).toBe(1);
    expect(result.error).toBe("unknown-mode");
  });

  test("rejects plan with no range", async () => {
    const repo = await makeRepo("no-range", ["initial commit"]);
    const { result } = await run(repo, ["plan"]);
    expect(result.error).toBe("missing-range");
  });

  test("rejects a misspelt --dry-run instead of rewriting history", async () => {
    const repo = await makeRepo("dryrun-typo", ["initial commit", "a"]);
    const head = await git(repo, "rev-parse", "HEAD");
    const list = await hashes(repo, 1);
    const plan = {
      base: await git(repo, "rev-parse", "HEAD~1"),
      steps: [step(list[0] ?? "", "reword", "feat: a")],
    };

    const { exitCode, result } = await run(repo, ["apply", "--dryrun"], JSON.stringify(plan));
    expect(exitCode).toBe(1);
    expect(result.error).toBe("unknown-argument");
    expect(result.detail).toContain("--dryrun");
    expect(await git(repo, "rev-parse", "HEAD")).toBe(head);
  });

  test("rejects a stray argument on a follow-up mode", async () => {
    const repo = await makeRepo("stray-arg", ["initial commit"]);
    const { result } = await run(repo, ["status", "--verbose"]);
    expect(result.error).toBe("unknown-argument");
  });
});
