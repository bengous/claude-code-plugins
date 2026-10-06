import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  branchMutations,
  extractCdTarget,
  isBranchMutatingCommand,
  isProtectedBranch,
} from "./guard-main-branch.ts";
import { HOOK_EXIT } from "./hook-io.ts";

// -- isProtectedBranch -------------------------------------------------------

describe("isProtectedBranch", () => {
  test("returns true for main", () => {
    expect(isProtectedBranch("main")).toBe(true);
  });

  test("returns true for master", () => {
    expect(isProtectedBranch("master")).toBe(true);
  });

  test("returns false for dev", () => {
    expect(isProtectedBranch("dev")).toBe(false);
  });

  test("returns false for feature branches", () => {
    expect(isProtectedBranch("feature/new-hook")).toBe(false);
  });

  test("returns false for fix branches", () => {
    expect(isProtectedBranch("fix/typo")).toBe(false);
  });
});

// -- extractCdTarget ---------------------------------------------------------

describe("extractCdTarget", () => {
  test("extracts unquoted path before &&", () => {
    expect(extractCdTarget("cd /tmp/foo && git commit")).toBe("/tmp/foo");
  });

  test("extracts double-quoted path", () => {
    expect(extractCdTarget('cd "/tmp/my dir" && git push')).toBe("/tmp/my dir");
  });

  test("extracts single-quoted path", () => {
    expect(extractCdTarget("cd '/tmp/foo' && git commit")).toBe("/tmp/foo");
  });

  test("extracts path before ;", () => {
    expect(extractCdTarget("cd /tmp/foo; git commit")).toBe("/tmp/foo");
  });

  test("returns null when no leading cd", () => {
    expect(extractCdTarget("git commit -m 'test'")).toBeNull();
  });

  test("returns null when cd is mid-command", () => {
    expect(extractCdTarget("git commit && cd /tmp")).toBeNull();
  });

  test("ignores leading whitespace", () => {
    expect(extractCdTarget("  cd /tmp && git commit")).toBe("/tmp");
  });
});

// -- branchMutations ---------------------------------------------------------

describe("branchMutations", () => {
  test("a mutation without options locates nothing", () => {
    expect(branchMutations("git commit -m 'x'")).toEqual([[]]);
  });

  test("keeps every -C in order, for git to chain", () => {
    expect(branchMutations("git -C /tmp/foo -C sub rebase dev")).toEqual([
      ["-C", "/tmp/foo", "-C", "sub"],
    ]);
  });

  test("unquotes a double-quoted -C path", () => {
    expect(branchMutations('git -C "/tmp/my dir" commit')).toEqual([["-C", "/tmp/my dir"]]);
  });

  test("unquotes a single-quoted -C path", () => {
    expect(branchMutations("git -C '/tmp/foo' merge dev")).toEqual([["-C", "/tmp/foo"]]);
  });

  test("skips global options that do not locate the repository", () => {
    expect(branchMutations("git -c user.name=x --no-pager -C /tmp/foo -p push")).toEqual([
      ["-C", "/tmp/foo"],
    ]);
  });

  test("keeps --git-dir in both spellings and skips --work-tree", () => {
    expect(branchMutations("git --git-dir=/tmp/g --work-tree /tmp/w commit")).toEqual([
      ["--git-dir", "/tmp/g"],
    ]);
    expect(branchMutations("git --git-dir '/tmp/g' --work-tree=/tmp/w commit")).toEqual([
      ["--git-dir", "/tmp/g"],
    ]);
  });

  test("lists every mutation of the command", () => {
    expect(branchMutations("git -C /tmp/foo commit -m 'x' && git push")).toEqual([
      ["-C", "/tmp/foo"],
      [],
    ]);
  });

  test("ignores a git invocation that does not mutate a branch", () => {
    expect(branchMutations("git -C /tmp/foo add . && git commit")).toEqual([[]]);
  });

  test("an option value that names a subcommand is no subcommand", () => {
    expect(branchMutations("git -c commit.gpgsign=false status")).toEqual([]);
  });
});

// -- isBranchMutatingCommand: blocked ----------------------------------------

describe("isBranchMutatingCommand blocks mutations", () => {
  const blocked = [
    "git commit -m 'test'",
    "git commit --amend",
    "git push origin main",
    "git push",
    "git merge dev",
    "git rebase dev",
    "git  commit -m 'test'",
    "git -C /tmp/foo commit -m 'test'",
    'git -C "/tmp/my dir" push',
    "git -C /tmp/foo -C sub merge dev",
    "git -c user.name=x commit -m 'test'",
    "git --no-pager commit",
    "git -p push",
    "git -C /tmp/foo -c k=v commit",
    "git --git-dir=/tmp/foo/.git commit",
    "git --git-dir /tmp/foo/.git --work-tree /tmp/foo rebase dev",
  ];

  for (const cmd of blocked) {
    test(`blocks: ${cmd}`, () => {
      expect(isBranchMutatingCommand(cmd)).toBe(true);
    });
  }
});

// -- isBranchMutatingCommand: allowed ----------------------------------------

describe("isBranchMutatingCommand allows non-mutations", () => {
  const allowed = [
    "git status",
    "git log --oneline",
    "git diff",
    "git checkout dev",
    "git branch -a",
    "git fetch origin",
    "git stash",
    "git show HEAD",
    "git remote -v",
    "git -C /tmp/foo status",
    "git -c commit.gpgsign=false status",
    "git -c rebase.autoStash=true pull",
    "ls -la",
    "bun test",
  ];

  for (const cmd of allowed) {
    test(`allows: ${cmd}`, () => {
      expect(isBranchMutatingCommand(cmd)).toBe(false);
    });
  }
});

// -- isBranchMutatingCommand: string literal bypass --------------------------

describe("isBranchMutatingCommand ignores mutations inside string literals", () => {
  const fullyQuoted = ['echo "git commit -m test"', "echo 'git push origin main'"];

  for (const cmd of fullyQuoted) {
    test(`allows fully-quoted: ${cmd}`, () => {
      expect(isBranchMutatingCommand(cmd)).toBe(false);
    });
  }

  // These commands ARE mutations (git commit), but the inner quoted text
  // (git push, git rebase) should not independently trigger a match.
  const outerMutationWithQuotedInner = [
    'git commit -m "fix: git push guard"',
    "git commit -m 'blocks git rebase'",
  ];

  for (const cmd of outerMutationWithQuotedInner) {
    test(`detects outer mutation despite quoted inner: ${cmd}`, () => {
      expect(isBranchMutatingCommand(cmd)).toBe(true);
    });
  }
});

// -- integration: subprocess -------------------------------------------------

describe("subprocess integration", () => {
  const hookPath = import.meta.dir + "/guard-main-branch.ts";

  async function runHook(command: string, env?: Record<string, string>) {
    const input = JSON.stringify({ tool_input: { command } });

    const proc = Bun.spawn(["bun", hookPath], {
      stdin: new Blob([input]),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...env },
    });

    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

    return { exitCode, stderr };
  }

  // Shared temp repo with multiple branches — created once, torn down once
  const tmpDir = `${import.meta.dir}/.tmp-test-repo`;

  beforeAll(() => {
    const init = Bun.spawnSync(
      [
        "bash",
        "-c",
        [
          // Joined by lines under `set -e`: the `|| true` of a branch below
          // would otherwise answer for the whole `&&` chain, and a failed
          // commit would leave an empty repo behind an exit code of 0.
          "set -e",
          `rm -rf "${tmpDir}"`,
          `mkdir -p "${tmpDir}"`,
          `cd "${tmpDir}"`,
          "git init -q",
          // A CI runner carries no git identity, and the owner's global config
          // signs every commit: the commit below needs one and reaches for no key.
          'git config user.email "test@test.com"',
          'git config user.name "Test"',
          "git config commit.gpgsign false",
          "git commit --allow-empty -m init -q",
          "git checkout -b main -q 2>/dev/null || true",
          "git branch master 2>/dev/null || true",
          "git branch feature/new-thing 2>/dev/null || true",
        ].join("\n"),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );

    if (init.exitCode !== 0) {
      throw new Error(`Failed to create test repo: ${init.stderr.toString()}`);
    }
  });

  afterAll(() => {
    Bun.spawnSync(["rm", "-rf", tmpDir]);
  });

  async function runHookOnBranch(command: string, branch: string, env?: Record<string, string>) {
    // Point HEAD at the desired branch without checkout (instant)
    Bun.spawnSync(
      ["git", "--git-dir", `${tmpDir}/.git`, "symbolic-ref", "HEAD", `refs/heads/${branch}`],
      { stdout: "pipe", stderr: "pipe" },
    );

    const input = JSON.stringify({ tool_input: { command } });

    const proc = Bun.spawn(["bun", hookPath], {
      stdin: new Blob([input]),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_DIR: `${tmpDir}/.git`, ...env },
    });

    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

    return { exitCode, stderr };
  }

  test("allows git diff on any branch", async () => {
    const { exitCode } = await runHook("git diff HEAD~1");
    expect(exitCode).toBe(HOOK_EXIT.ALLOW);
  });

  test("allows with MAIN_BYPASS=1", async () => {
    const { exitCode } = await runHook("git commit -m 'test'", {
      MAIN_BYPASS: "1",
    });

    expect(exitCode).toBe(HOOK_EXIT.ALLOW);
  });

  test("exits 0 on invalid JSON input", async () => {
    const proc = Bun.spawn(["bun", hookPath], {
      stdin: new Blob(["not json"]),
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(await proc.exited).toBe(HOOK_EXIT.ALLOW);
  });

  test("exits 0 on empty input", async () => {
    const proc = Bun.spawn(["bun", hookPath], {
      stdin: new Blob([""]),
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(await proc.exited).toBe(HOOK_EXIT.ALLOW);
  });

  // -- protected branch tests (using temp git repos) -----------------------

  test("blocks git commit on main", async () => {
    const { exitCode, stderr } = await runHookOnBranch("git commit -m 'test'", "main");
    expect(exitCode).toBe(HOOK_EXIT.BLOCK);
    expect(stderr).toContain("BLOCKED");
    expect(stderr).toContain("main");
  });

  test("blocks git push on main", async () => {
    const { exitCode, stderr } = await runHookOnBranch("git push origin main", "main");
    expect(exitCode).toBe(HOOK_EXIT.BLOCK);
    expect(stderr).toContain("BLOCKED");
  });

  test("blocks git merge on master", async () => {
    const { exitCode, stderr } = await runHookOnBranch("git merge dev", "master");
    expect(exitCode).toBe(HOOK_EXIT.BLOCK);
    expect(stderr).toContain("master");
  });

  test("blocks git rebase on main", async () => {
    const { exitCode } = await runHookOnBranch("git rebase dev", "main");
    expect(exitCode).toBe(HOOK_EXIT.BLOCK);
  });

  test("allows git commit on feature branch", async () => {
    const { exitCode } = await runHookOnBranch("git commit -m 'test'", "feature/new-thing");
    expect(exitCode).toBe(HOOK_EXIT.ALLOW);
  });

  // Non-mutating commands short-circuit before branch check, so
  // runHook (no temp repo needed) is sufficient and faster.
  test("allows git status regardless of branch", async () => {
    const { exitCode } = await runHook("git status");
    expect(exitCode).toBe(HOOK_EXIT.ALLOW);
  });

  test("allows git log regardless of branch", async () => {
    const { exitCode } = await runHook("git log --oneline");
    expect(exitCode).toBe(HOOK_EXIT.ALLOW);
  });

  test("MAIN_BYPASS=1 allows git commit on main", async () => {
    const { exitCode } = await runHookOnBranch("git commit -m 'emergency'", "main", {
      MAIN_BYPASS: "1",
    });

    expect(exitCode).toBe(HOOK_EXIT.ALLOW);
  });

  // Regression: the project repo must be resolved from CLAUDE_PROJECT_DIR, not
  // from the hook's cwd. A shell cwd that drifted into the other repo used to
  // make both roots look identical, re-policing a repo with its own conventions.
  test("allows cd-prefixed commit on another repo's main when cwd drifted there", async () => {
    Bun.spawnSync(
      ["git", "--git-dir", `${tmpDir}/.git`, "symbolic-ref", "HEAD", "refs/heads/main"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const projectDir = `${import.meta.dir}/../..`;

    const input = JSON.stringify({
      tool_input: { command: `cd ${tmpDir} && git commit -m 'x'` },
    });

    const proc = Bun.spawn(["bun", hookPath], {
      stdin: new Blob([input]),
      stdout: "pipe",
      stderr: "pipe",
      cwd: tmpDir,
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    });

    expect(await proc.exited).toBe(HOOK_EXIT.ALLOW);
  });

  async function runHookInOtherRepo(command: string, projectDir: string) {
    Bun.spawnSync(
      ["git", "--git-dir", `${tmpDir}/.git`, "symbolic-ref", "HEAD", "refs/heads/main"],
      { stdout: "pipe", stderr: "pipe" },
    );

    const proc = Bun.spawn(["bun", hookPath], {
      stdin: new Blob([JSON.stringify({ tool_input: { command } })]),
      stdout: "pipe",
      stderr: "pipe",
      cwd: tmpDir,
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    });

    return await proc.exited;
  }

  for (const [label, projectDir] of [
    ["empty", ""],
    ["the other repo", tmpDir],
  ] as const) {
    test(`allows cd-prefixed commit on another repo's main when CLAUDE_PROJECT_DIR is ${label}`, async () => {
      const exitCode = await runHookInOtherRepo(`cd ${tmpDir} && git commit -m 'x'`, projectDir);
      expect(exitCode).toBe(HOOK_EXIT.ALLOW);
    });
  }

  test("allows a commit without cd when the hook's cwd is another repo on main", async () => {
    const exitCode = await runHookInOtherRepo("git commit -m 'x'", `${import.meta.dir}/../..`);
    expect(exitCode).toBe(HOOK_EXIT.ALLOW);
  });
});

// -- integration: the repo that carries the hook stays guarded ----------------

describe("own repo", () => {
  let fixture = "";
  let worktree = "";
  let copiedHook = "";

  beforeAll(() => {
    fixture = mkdtempSync(join(tmpdir(), "guard-main-branch-own-"));
    worktree = `${fixture}-wt`;
    copiedHook = `${fixture}/.claude/hooks/guard-main-branch.ts`;

    const init = Bun.spawnSync(
      [
        "bash",
        "-c",
        [
          `cd "${fixture}"`,
          "git init -q -b main",
          // A CI runner carries no git identity, and the owner's global config
          // signs every commit: the commit below needs one and reaches for no key.
          'git config user.email "test@test.com"',
          'git config user.name "Test"',
          "git config commit.gpgsign false",
          "git commit --allow-empty -m init -q",
          "git branch master",
          `git worktree add -q "${worktree}" master`,
          "mkdir -p .claude/hooks",
          `cp "${import.meta.dir}/guard-main-branch.ts" "${import.meta.dir}/hook-io.ts" .claude/hooks/`,
        ].join(" && "),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );

    if (init.exitCode !== 0) {
      throw new Error(`Failed to create own-repo fixture: ${init.stderr.toString()}`);
    }
  });

  afterAll(() => {
    Bun.spawnSync(["rm", "-rf", fixture, worktree]);
  });

  async function runCopiedHook(command: string, cwd: string = import.meta.dir) {
    const proc = Bun.spawn(["bun", copiedHook], {
      stdin: new Blob([JSON.stringify({ tool_input: { command } })]),
      stdout: "pipe",
      stderr: "pipe",
      cwd,
      env: { ...process.env, CLAUDE_PROJECT_DIR: "" },
    });

    return await proc.exited;
  }

  test("blocks a commit on main from the main checkout", async () => {
    expect(await runCopiedHook(`cd ${fixture} && git commit -m 'x'`)).toBe(HOOK_EXIT.BLOCK);
  });

  test("blocks a commit on master from a linked worktree", async () => {
    expect(await runCopiedHook(`cd ${worktree} && git commit -m 'x'`)).toBe(HOOK_EXIT.BLOCK);
  });

  test("blocks a commit aimed at main by an absolute -C from another repo", async () => {
    expect(await runCopiedHook(`git -C ${fixture} commit -m 'x'`)).toBe(HOOK_EXIT.BLOCK);
  });

  test("blocks a commit aimed at main by a -C relative to a leading cd", async () => {
    const command = `cd ${dirname(fixture)} && git -C ${basename(fixture)} commit -m 'x'`;
    expect(await runCopiedHook(command)).toBe(HOOK_EXIT.BLOCK);
  });

  test("blocks a commit aimed at master by a quoted -C", async () => {
    expect(await runCopiedHook(`git -C "${worktree}" commit -m 'x'`)).toBe(HOOK_EXIT.BLOCK);
  });

  test("allows a commit aimed at another repo by -C from a main checkout", async () => {
    const exitCode = await runCopiedHook(`git -C ${import.meta.dir} commit -m 'x'`, fixture);
    expect(exitCode).toBe(HOOK_EXIT.ALLOW);
  });

  test("blocks a commit aimed at main by chained relative -C options", async () => {
    const command = `git -C ${dirname(fixture)} -C ${basename(fixture)} commit -m 'x'`;
    expect(await runCopiedHook(command)).toBe(HOOK_EXIT.BLOCK);
  });

  test("blocks a commit on main behind -c", async () => {
    const exitCode = await runCopiedHook("git -c user.name=x commit -m 'x'", fixture);
    expect(exitCode).toBe(HOOK_EXIT.BLOCK);
  });

  test("blocks a commit on main behind --no-pager", async () => {
    const exitCode = await runCopiedHook("git --no-pager commit -m 'x'", fixture);
    expect(exitCode).toBe(HOOK_EXIT.BLOCK);
  });

  test("blocks a commit aimed at main by -C followed by -c", async () => {
    const command = `git -C ${fixture} -c user.name=x commit -m 'x'`;
    expect(await runCopiedHook(command)).toBe(HOOK_EXIT.BLOCK);
  });

  test("blocks a commit on main after another one aimed at another repo", async () => {
    const command = `git -C ${import.meta.dir} commit -m 'x' && git commit -m 'y'`;
    expect(await runCopiedHook(command, fixture)).toBe(HOOK_EXIT.BLOCK);
  });

  test("blocks a commit aimed at main by --git-dir from another repo", async () => {
    const command = `git --git-dir=${fixture}/.git commit -m 'x'`;
    expect(await runCopiedHook(command)).toBe(HOOK_EXIT.BLOCK);
  });

  test("allows a commit aimed at another repo by --git-dir from a main checkout", async () => {
    const command = `git --git-dir ${import.meta.dir}/../../.git commit -m 'x'`;
    expect(await runCopiedHook(command, fixture)).toBe(HOOK_EXIT.ALLOW);
  });

  test("blocks a commit on main whose --work-tree points elsewhere", async () => {
    const command = `git --work-tree=${import.meta.dir} commit -m 'x'`;
    expect(await runCopiedHook(command, fixture)).toBe(HOOK_EXIT.BLOCK);
  });
});
