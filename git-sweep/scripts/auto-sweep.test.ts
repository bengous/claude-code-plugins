import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CLOSED_PR_GRACE_DAYS,
  isAgentWorktree,
  isDisposable,
  judgeUnproven,
  leftoversOf,
  NO_PR_IDLE_DAYS,
  parsePullLines,
  type Pull,
  type PullLookup,
  runningAgentBranches,
} from "./auto-sweep.ts";
import { parseWorktreeList } from "./worktrees.ts";

const SCRIPT = join(import.meta.dir, "auto-sweep.ts");

const DAY_MS = 86_400_000;

// Isolated from the developer's global/system git config: a real sweep.* key
// there would silently change what these tests assert.
const GIT_ISOLATION = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

let tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `auto-sweep-test-${prefix}-`));
  tmpDirs.push(dir);

  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

async function run(
  cwd: string,
  command: string[],
  env: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...GIT_ISOLATION, ...env },
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await run(cwd, ["git", ...args]);

  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);

  return result.stdout;
}

const sweep = (cwd: string, args: string[] = [], env: Record<string, string> = {}) =>
  run(cwd, ["bun", "run", SCRIPT, ...args], env);

async function branchExists(repo: string, name: string): Promise<boolean> {
  return (
    (await run(repo, ["git", "rev-parse", "--verify", "--quiet", `refs/heads/${name}`]))
      .exitCode === 0
  );
}

// main and dev at the same first commit, main checked out: dev is the base.
async function makeRepo(prefix: string): Promise<string> {
  const repo = makeTmpDir(prefix);
  await git(repo, "init", "--initial-branch=main");
  await git(repo, "config", "user.email", "test@test.com");
  await git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n*.env\nplans/\n/*/tsconfig.json\n");
  mkdirSync(join(repo, "pinpoint"));
  writeFileSync(join(repo, "pinpoint", "README.md"), "a plugin");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "initial commit");
  await git(repo, "branch", "dev");

  return repo;
}

async function commitDaysAgo(cwd: string, file: string, days: number): Promise<void> {
  writeFileSync(join(cwd, file), file);
  await git(cwd, "add", file);
  const date = new Date(Date.now() - days * DAY_MS).toISOString();

  const result = await run(cwd, ["git", "commit", "-m", `add ${file}`], {
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  });

  if (result.exitCode !== 0) throw new Error(result.stderr);
}

const agentPath = (repo: string, id: string): string =>
  join(repo, ".claude", "worktrees", `agent-${id}`);

// A worktree on a new branch at dev's tip: contained in the base by ancestry.
async function addWorktree(repo: string, path: string, branch: string): Promise<string> {
  await git(repo, "worktree", "add", "-b", branch, path, "dev");

  return path;
}

describe("isAgentWorktree", () => {
  test("only a direct agent- child of the main worktree's .claude/worktrees", () => {
    expect(isAgentWorktree("/r/.claude/worktrees/agent-a1", "/r")).toBe(true);
    expect(isAgentWorktree("/r/.claude/worktrees/named", "/r")).toBe(false);
    expect(isAgentWorktree("/r/.claude/worktrees/agent-", "/r")).toBe(false);
    expect(isAgentWorktree("/r/.claude/worktrees/agent-a1/nested", "/r")).toBe(false);
    expect(isAgentWorktree("/other/.claude/worktrees/agent-a1", "/r")).toBe(false);
  });
});

describe("isDisposable", () => {
  test("names what a checkout regenerates, nothing else", () => {
    for (const path of [
      "node_modules/",
      "vellum/node_modules/",
      "scripts/__pycache__/",
      ".stryker-tmp/",
      "vellum/test-results/",
      "flaky-reports/",
      "pinpoint/tsconfig.json",
      "todos/.claude-plugin/types/",
    ]) {
      expect(isDisposable(path)).toBe(true);
    }

    for (const path of [
      "plans/",
      "local.env",
      "tsconfig.json",
      "a/b/tsconfig.json",
      "node_modules.bak/",
      ".claude/settings.local.json",
      "test-results/",
    ]) {
      expect(isDisposable(path)).toBe(false);
    }
  });
});

describe("runningAgentBranches", () => {
  test("names the branch Claude Code created for each locked agent worktree", () => {
    const list = parseWorktreeList(
      [
        "worktree /r\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/dev",
        "worktree /r/.claude/worktrees/agent-a1\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/feature/x\nlocked claude agent agent-a1 (pid 1 start 2)",
        "worktree /r/.claude/worktrees/agent-a2\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/feature/y",
        "worktree /r/.claude/worktrees/named\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/feature/z\nlocked",
      ].join("\n\n"),
    );

    if ("error" in list) throw new Error(list.error);
    const running = runningAgentBranches(list, (path) => isAgentWorktree(path, "/r"));

    expect([...running.keys()]).toEqual(["worktree-agent-a1"]);
  });
});

const found = (pulls: Pull[]): PullLookup => ({ kind: "found", pulls });

describe("judgeUnproven", () => {
  const now = new Date("2026-10-20T12:00:00Z");
  const daysAgo = (days: number): Date => new Date(now.getTime() - days * DAY_MS);

  const closed = (number: number, days: number): Pull => ({
    number,
    state: "CLOSED" as const,
    closedAt: daysAgo(days),
  });

  test("no pull request: archived once the last commit is NO_PR_IDLE_DAYS old", () => {
    expect(judgeUnproven(daysAgo(NO_PR_IDLE_DAYS), found([]), now).archive).toBe(true);
    expect(judgeUnproven(daysAgo(NO_PR_IDLE_DAYS - 1), found([]), now)).toEqual({
      archive: false,
      why: `no PR, last commit ${NO_PR_IDLE_DAYS - 1} day(s) ago; archived after ${NO_PR_IDLE_DAYS} days`,
    });
  });

  test("closed unmerged: archived once the close and the last commit pass the grace", () => {
    const grace = CLOSED_PR_GRACE_DAYS;

    expect(judgeUnproven(daysAgo(grace), found([closed(7, grace)]), now).archive).toBe(true);
    expect(judgeUnproven(daysAgo(grace), found([closed(7, grace - 1)]), now).archive).toBe(false);
    expect(judgeUnproven(daysAgo(1), found([closed(7, grace + 5)]), now).archive).toBe(false);
  });

  test("the latest closed pull request decides", () => {
    const verdict = judgeUnproven(daysAgo(40), found([closed(3, 40), closed(9, 2)]), now);

    expect(verdict.archive).toBe(false);
    expect(verdict.why).toStartWith("PR #9 closed unmerged 2 day(s) ago");
  });

  test("an open or merged pull request, or none readable, keeps the branch", () => {
    const old = daysAgo(400);

    expect(
      judgeUnproven(
        old,
        found([closed(1, 400), { number: 2, state: "OPEN", closedAt: null }]),
        now,
      ),
    ).toEqual({ archive: false, why: "PR #2 is open" });
    expect(
      judgeUnproven(old, found([{ number: 4, state: "MERGED", closedAt: daysAgo(300) }]), now)
        .archive,
    ).toBe(false);
    expect(judgeUnproven(old, { kind: "unknown", reason: "gh pr list failed" }, now).archive).toBe(
      false,
    );
    expect(
      judgeUnproven(old, found([{ number: 5, state: "CLOSED", closedAt: null }]), now).archive,
    ).toBe(false);
  });
});

describe("parsePullLines", () => {
  test("keeps the branch's own pull requests, a missing close as null", () => {
    expect(
      parsePullLines(
        [
          "12 CLOSED 2026-10-01T00:00:00Z false feature/x",
          "13 OPEN - false feature/x",
          "14 MERGED 2026-10-02T00:00:00Z false feature/y",
        ].join("\n"),
        "feature/x",
      ),
    ).toEqual([
      { number: 12, state: "CLOSED", closedAt: new Date("2026-10-01T00:00:00Z") },
      { number: 13, state: "OPEN", closedAt: null },
    ]);
  });

  test("leaves out a fork's pull request from a branch of the same name", () => {
    expect(parsePullLines("15 CLOSED 2026-09-01T00:00:00Z true feature/x", "feature/x")).toEqual(
      [],
    );
  });

  test("a line it cannot read fails the whole answer", () => {
    expect(parsePullLines("12 DRAFT - false feature/x", "feature/x")).toBeNull();
    expect(parsePullLines("12 CLOSED yesterday false feature/x", "feature/x")).toBeNull();
    expect(parsePullLines("12 CLOSED - feature/x", "feature/x")).toBeNull();
    expect(parsePullLines("", "feature/x")).toEqual([]);
  });
});

describe("auto-sweep", () => {
  test("deletes a proven branch, and removes a clean agent worktree with its branch", async () => {
    const repo = await makeRepo("proven");
    await git(repo, "switch", "-c", "feature/done");
    await commitDaysAgo(repo, "done.txt", 1);
    await git(repo, "switch", "main");
    await git(repo, "branch", "-f", "dev", "feature/done");
    const agent = await addWorktree(repo, agentPath(repo, "a1"), "feature/agent-done");

    const { exitCode, stdout } = await sweep(repo);

    expect(exitCode).toBe(0);
    expect(stdout).toStartWith("auto-sweep against dev");
    expect(stdout).toContain("feature/done (ancestry)");
    expect(stdout).toContain("agent-a1 on feature/agent-done (ancestry)\n");
    expect(await branchExists(repo, "feature/done")).toBe(false);
    expect(await branchExists(repo, "feature/agent-done")).toBe(false);
    expect(existsSync(agent)).toBe(false);
  });

  test("removes an agent worktree holding only disposable ignored paths, keeps one holding plans/", async () => {
    const repo = await makeRepo("disposable");
    const built = await addWorktree(repo, agentPath(repo, "a8"), "feature/built");
    mkdirSync(join(built, "node_modules"));
    writeFileSync(join(built, "node_modules", "dep.js"), "");
    writeFileSync(join(built, "pinpoint", "tsconfig.json"), "{}");
    const planned = await addWorktree(repo, agentPath(repo, "a9"), "feature/planned");
    mkdirSync(join(planned, "node_modules"));
    mkdirSync(join(planned, "plans"));
    writeFileSync(join(planned, "plans", "only-copy.md"), "the plan");

    const { exitCode, stdout } = await sweep(repo);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("(ancestry; removes node_modules/, pinpoint/tsconfig.json)");
    expect(stdout).toContain(
      "feature/planned: worktree: .claude/worktrees/agent-a9 holds ignored plans/, not known disposable",
    );
    expect(existsSync(built)).toBe(false);
    expect(await branchExists(repo, "feature/built")).toBe(false);
    expect(existsSync(join(planned, "plans", "only-copy.md"))).toBe(true);
    expect(await branchExists(repo, "feature/planned")).toBe(true);
  });

  test("drops a stale agent registration with its branch, keeps a stale non-agent one", async () => {
    const repo = await makeRepo("stale");
    const agent = await addWorktree(repo, agentPath(repo, "a6"), "feature/agent-gone");
    const other = await addWorktree(repo, join(makeTmpDir("other"), "wt"), "feature/other-gone");
    rmSync(agent, { recursive: true });
    rmSync(other, { recursive: true });

    const { exitCode, stdout } = await sweep(repo);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("agent-a6 on feature/agent-gone (directory gone)");
    expect(stdout).toContain("feature/other-gone: stale worktree");
    expect(stdout).toContain("is not an agent worktree, not swept");
    expect(await branchExists(repo, "feature/agent-gone")).toBe(false);
    expect(await branchExists(repo, "feature/other-gone")).toBe(true);
    expect(await git(repo, "worktree", "list")).not.toContain("agent-a6");
  });

  test("keeps protected, current, dirty, locked and non-agent worktree branches", async () => {
    const repo = await makeRepo("kept");
    const dirty = await addWorktree(repo, agentPath(repo, "a2"), "feature/dirty");
    writeFileSync(join(dirty, "wip.txt"), "uncommitted");
    const secret = await addWorktree(repo, agentPath(repo, "a3"), "feature/secret");
    writeFileSync(join(secret, "local.env"), "TOKEN=1");
    const locked = await addWorktree(repo, agentPath(repo, "a4"), "feature/locked");
    await git(repo, "worktree", "lock", "--reason", "claude agent agent-a4", locked);
    await git(repo, "branch", "worktree-agent-a4", "dev");

    const named = await addWorktree(
      repo,
      join(repo, ".claude", "worktrees", "named"),
      "feature/named",
    );

    const outside = await addWorktree(repo, join(makeTmpDir("outside"), "wt"), "feature/outside");
    await git(repo, "switch", "-c", "feature/here", "dev");

    const { exitCode, stdout } = await sweep(repo);

    expect(exitCode).toBe(0);
    expect(stdout).not.toContain("Deleted");
    expect(stdout).toContain("main: protected");
    expect(stdout).toContain("feature/here: current");
    expect(stdout).toContain("feature/dirty: dirty-worktree");
    expect(stdout).toContain("agent-a3 holds ignored local.env, not known disposable");
    expect(stdout).toContain("feature/named: named worktree .claude/worktrees/named, not swept");
    expect(stdout).toContain(`worktree-agent-a4: its agent still runs in`);

    for (const branch of ["main", "dev", "feature/here", "feature/dirty", "feature/secret"]) {
      expect(await branchExists(repo, branch)).toBe(true);
    }

    for (const branch of [
      "feature/locked",
      "worktree-agent-a4",
      "feature/named",
      "feature/outside",
    ]) {
      expect(await branchExists(repo, branch)).toBe(true);
    }

    for (const path of [dirty, secret, locked, named, outside]) expect(existsSync(path)).toBe(true);
  });

  test("archives an old unproven agent branch, then deletes it with its clean worktree", async () => {
    const repo = await makeRepo("archive");
    await git(repo, "switch", "-c", "worktree-agent-old");
    await commitDaysAgo(repo, "old.txt", NO_PR_IDLE_DAYS + 10);
    const oldTip = await git(repo, "rev-parse", "HEAD");
    await git(repo, "switch", "-c", "worktree-agent-young", "main");
    await commitDaysAgo(repo, "young.txt", 5);
    await git(repo, "switch", "-c", "feature/user-old", "main");
    await commitDaysAgo(repo, "user.txt", NO_PR_IDLE_DAYS + 10);
    await git(repo, "switch", "main");
    const abandoned = await addWorktree(repo, agentPath(repo, "a5"), "feature/abandoned");
    await commitDaysAgo(abandoned, "abandoned.txt", NO_PR_IDLE_DAYS + 10);
    const abandonedTip = await git(abandoned, "rev-parse", "HEAD");

    const { exitCode, stdout } = await sweep(repo);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("worktree-agent-old -> refs/archive/worktree-agent-old");
    expect(stdout).toContain("feature/abandoned -> refs/archive/feature/abandoned");
    expect(stdout).toContain("refs/archive/ holds 2 ref(s)");
    expect(stdout).toContain("worktree-agent-young: unproven");
    expect(stdout).toContain("archived after 30 days");
    expect(await branchExists(repo, "worktree-agent-old")).toBe(false);
    expect(await branchExists(repo, "feature/abandoned")).toBe(false);
    expect(existsSync(abandoned)).toBe(false);
    expect(await branchExists(repo, "worktree-agent-young")).toBe(true);
    expect(await branchExists(repo, "feature/user-old")).toBe(true);
    expect(await git(repo, "rev-parse", "refs/archive/feature/abandoned")).toBe(abandonedTip);

    await git(repo, "branch", "worktree-agent-old", "refs/archive/worktree-agent-old");

    expect(await git(repo, "rev-parse", "refs/heads/worktree-agent-old")).toBe(oldTip);
  });

  test("--dry-run reports the plan and changes nothing", async () => {
    const repo = await makeRepo("dry-run");
    await git(repo, "branch", "feature/merged", "dev");
    await git(repo, "switch", "-c", "worktree-agent-old");
    await commitDaysAgo(repo, "old.txt", NO_PR_IDLE_DAYS + 10);
    await git(repo, "switch", "main");

    const { exitCode, stdout } = await sweep(repo, ["--dry-run"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("dry run: nothing changed");
    expect(stdout).toContain("Would delete branches (1):\n  feature/merged (ancestry)");
    expect(stdout).toContain("Would archive branches (1):\n  worktree-agent-old ->");
    expect(await branchExists(repo, "feature/merged")).toBe(true);
    expect(await branchExists(repo, "worktree-agent-old")).toBe(true);
    expect(await git(repo, "for-each-ref", "refs/archive/")).toBe("");
  });

  test("an archive ref already holding another commit keeps the branch", async () => {
    const repo = await makeRepo("archive-taken");
    await git(repo, "update-ref", "refs/archive/worktree-agent-old", "main");
    await git(repo, "switch", "-c", "worktree-agent-old");
    await commitDaysAgo(repo, "old.txt", NO_PR_IDLE_DAYS + 10);
    await git(repo, "switch", "main");

    const { exitCode, stdout } = await sweep(repo);

    expect(exitCode).toBe(1);
    expect(stdout).toContain(
      "archive worktree-agent-old: refs/archive/worktree-agent-old already holds",
    );
    expect(await branchExists(repo, "worktree-agent-old")).toBe(true);
  });

  test("a deletion that fails drops the archive ref it wrote", async () => {
    const repo = await makeRepo("rollback");
    const abandoned = await addWorktree(repo, agentPath(repo, "a7"), "feature/abandoned");
    await commitDaysAgo(abandoned, "abandoned.txt", NO_PR_IDLE_DAYS + 10);
    const realGit = Bun.which("git");

    if (realGit === null) throw new Error("git not found on PATH");
    const shimDir = makeTmpDir("git-shim");

    writeFileSync(
      join(shimDir, "git"),
      `#!/usr/bin/env bash
if [[ "$1" == "worktree" && "$2" == "remove" ]]; then
  echo "fatal: simulated failure" >&2
  exit 128
fi
exec ${realGit} "$@"
`,
      { mode: 0o755 },
    );

    const { exitCode, stdout } = await sweep(repo, [], { PATH: `${shimDir}:${process.env.PATH}` });

    expect(exitCode).toBe(1);
    expect(stdout).toContain("Failed (2):");
    expect(stdout).not.toContain("Archived");
    expect(await branchExists(repo, "feature/abandoned")).toBe(true);
    expect(existsSync(abandoned)).toBe(true);
    expect(await git(repo, "for-each-ref", "refs/archive/")).toBe("");
  });

  test("deletes a backup contained by ancestry, keeps one whose commits are not in the base", async () => {
    const repo = await makeRepo("backup");
    await git(repo, "branch", "backup/merged", "dev");
    await git(repo, "switch", "-c", "backup/squashed");
    await commitDaysAgo(repo, "work.txt", 1);
    await git(repo, "switch", "dev");
    await git(repo, "cherry-pick", "backup/squashed");
    await git(repo, "switch", "main");

    const { stdout } = await sweep(repo);

    expect(stdout).toContain("backup/merged (ancestry)");
    expect(stdout).toContain("backup/squashed: backup: no-merge-delta");
    expect(await branchExists(repo, "backup/merged")).toBe(false);
    expect(await branchExists(repo, "backup/squashed")).toBe(true);
  });

  test("an explicit --base wins over dev", async () => {
    const repo = await makeRepo("base");
    await git(repo, "switch", "-c", "feature/on-main");
    await commitDaysAgo(repo, "main.txt", 1);
    await git(repo, "switch", "main");
    await git(repo, "merge", "--ff-only", "feature/on-main");

    const { stdout } = await sweep(repo, ["--dry-run", "--base", "main"]);

    expect(stdout).toStartWith("auto-sweep against main");
    expect(stdout).toContain("feature/on-main (ancestry)");
  });

  test("reads pull requests through gh: a closed one past the grace archives, an open or a fork's one keeps", async () => {
    const repo = await makeRepo("gh");
    await git(repo, "remote", "add", "origin", makeTmpDir("origin"));
    await git(repo, "switch", "-c", "worktree-agent-closed");
    await commitDaysAgo(repo, "closed.txt", CLOSED_PR_GRACE_DAYS + 6);
    await git(repo, "switch", "-c", "worktree-agent-open", "main");
    await commitDaysAgo(repo, "open.txt", NO_PR_IDLE_DAYS + 10);
    await git(repo, "switch", "-c", "worktree-agent-forked", "main");
    await commitDaysAgo(repo, "forked.txt", CLOSED_PR_GRACE_DAYS + 6);
    await git(repo, "switch", "main");
    const closedAt = new Date(Date.now() - (CLOSED_PR_GRACE_DAYS + 5) * DAY_MS).toISOString();
    const shimDir = makeTmpDir("gh-shim");

    writeFileSync(
      join(shimDir, "gh"),
      `#!/usr/bin/env bash
case "$*" in
  "repo view"*) echo '{"nameWithOwner":"owner/repo"}' ;;
  *"--state all"*isCrossRepository*) printf '7 CLOSED ${closedAt} false worktree-agent-closed\\n8 OPEN - false worktree-agent-open\\n9 CLOSED ${closedAt} true worktree-agent-forked\\n' ;;
  *"--state merged"*|api*) echo '[]' ;;
  *) exit 1 ;;
esac
`,
      { mode: 0o755 },
    );

    const { exitCode, stdout } = await sweep(repo, [], { PATH: `${shimDir}:${process.env.PATH}` });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("worktree-agent-closed -> refs/archive/worktree-agent-closed");
    expect(stdout).toContain(`PR #7 closed unmerged ${CLOSED_PR_GRACE_DAYS + 5} day(s) ago`);
    expect(stdout).toContain("worktree-agent-open: unproven");
    expect(stdout).toContain("PR #8 is open");
    expect(stdout).toContain(`worktree-agent-forked: unproven`);
    expect(stdout).toContain(`no PR, last commit ${CLOSED_PR_GRACE_DAYS + 6} day(s) ago`);
    expect(await branchExists(repo, "worktree-agent-closed")).toBe(false);
    expect(await branchExists(repo, "worktree-agent-open")).toBe(true);
    expect(await branchExists(repo, "worktree-agent-forked")).toBe(true);
  });

  test("an untracked file keeps its worktree when status.showUntrackedFiles is no", async () => {
    const repo = await makeRepo("untracked");
    const agent = await addWorktree(repo, agentPath(repo, "x1"), "feature/agent-done");
    writeFileSync(join(agent, "notes.md"), "only copy of my notes");
    await git(repo, "config", "status.showUntrackedFiles", "no");

    const { exitCode, stdout } = await sweep(repo);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("feature/agent-done: dirty-worktree: .claude/worktrees/agent-x1");
    expect(existsSync(join(agent, "notes.md"))).toBe(true);
    expect(await branchExists(repo, "feature/agent-done")).toBe(true);
  });

  test("leftoversOf sees the untracked file status.showUntrackedFiles=no hides", async () => {
    const repo = await makeRepo("leftovers");
    const agent = await addWorktree(repo, agentPath(repo, "x2"), "feature/x2");
    mkdirSync(join(agent, "node_modules"));
    writeFileSync(join(agent, "node_modules", "dep.js"), "");
    writeFileSync(join(agent, "notes.md"), "only copy of my notes");
    await git(repo, "config", "status.showUntrackedFiles", "no");

    expect(await leftoversOf(agent)).toEqual({
      kind: "kept",
      why: `${agent} has uncommitted or untracked changes`,
    });

    rmSync(join(agent, "notes.md"));

    expect(await leftoversOf(agent)).toEqual({ kind: "disposable", paths: ["node_modules/"] });
  });

  test("keeps the archive of a branch another run deleted meanwhile", async () => {
    const repo = await makeRepo("concurrent");
    await git(repo, "switch", "-c", "worktree-agent-old");
    await commitDaysAgo(repo, "old.txt", NO_PR_IDLE_DAYS + 10);
    const oldTip = await git(repo, "rev-parse", "HEAD");
    await git(repo, "switch", "main");
    const realGit = Bun.which("git");

    if (realGit === null) throw new Error("git not found on PATH");
    const shimDir = makeTmpDir("git-shim");

    writeFileSync(
      join(shimDir, "git"),
      `#!/usr/bin/env bash
if [[ "$1" == "branch" && "$2" == "--show-current" ]] && ${realGit} rev-parse --verify --quiet refs/archive/worktree-agent-old >/dev/null; then
  ${realGit} branch -D worktree-agent-old >/dev/null 2>&1
fi
exec ${realGit} "$@"
`,
      { mode: 0o755 },
    );

    const { exitCode, stdout } = await sweep(repo, [], { PATH: `${shimDir}:${process.env.PATH}` });

    expect(exitCode).toBe(1);
    expect(stdout).toContain("branch-delete worktree-agent-old: branch no longer exists");
    expect(await branchExists(repo, "worktree-agent-old")).toBe(false);
    expect(await git(repo, "rev-parse", "refs/archive/worktree-agent-old")).toBe(oldTip);
  });
});
