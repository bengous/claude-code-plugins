import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  type Check,
  checkoutOf,
  land,
  latestChecks,
  movedOn,
  type PullRequest,
  refusalOf,
} from "./land.ts";

let root = "";

let origin = "";

let work = "";

let other = "";

let prFile = "";

const saved = new Map<string, string | undefined>();

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });

  if (result.exitCode !== 0) throw new Error(result.stderr.toString());

  return result.stdout.toString().trim();
}

function setEnv(name: string, value: string) {
  if (!saved.has(name)) saved.set(name, process.env[name]);
  process.env[name] = value;
}

function clone(name: string): string {
  const path = join(root, name);

  git(root, "clone", "--quiet", origin, path);
  git(path, "config", "user.name", "Test");
  git(path, "config", "user.email", "test@example.com");

  return path;
}

function commit(cwd: string, file: string, message: string): string {
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  writeFileSync(join(cwd, file), `${message}\n`);
  git(cwd, "add", file);
  git(cwd, "commit", "--quiet", "-m", message);

  return git(cwd, "rev-parse", "HEAD");
}

function green(name = "validate (scoped)"): Check {
  return { name, startedAt: "2026-10-15T10:00:00Z", state: "SUCCESS" };
}

function pullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 7,
    state: "OPEN",
    baseRefName: "dev",
    headRefOid: git(work, "rev-parse", "HEAD"),
    checks: [green()],
    ...overrides,
  };
}

function serve(pr: PullRequest) {
  writeFileSync(prFile, JSON.stringify(pr));
}

function moveDev(): string {
  const moved = commit(other, "c.txt", "elsewhere");

  git(other, "push", "--quiet", "origin", "dev");

  return moved;
}

function why(landing: ReturnType<typeof land>): string {
  return landing.kind === "refused" ? landing.why : "";
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "land-"));
  // The fixtures run git as a fresh machine would: no hook manager, signing or push default of the user's.
  setEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  setEnv("GIT_CONFIG_NOSYSTEM", "1");

  origin = join(root, "origin.git");
  git(root, "init", "--quiet", "--bare", "--initial-branch=dev", "origin.git");

  work = clone("work");
  commit(work, "a.txt", "base");
  git(work, "push", "--quiet", "origin", "dev");
  git(work, "switch", "--quiet", "-c", "feature/x");
  commit(work, "b.txt", "feature");
  git(work, "push", "--quiet", "origin", "feature/x");

  other = clone("other");

  const bin = join(root, "bin");

  prFile = join(root, "pr.json");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), `#!/bin/sh\ncat "${prFile}"\n`);
  chmodSync(join(bin, "gh"), 0o755);
  setEnv("PATH", `${bin}:${process.env["PATH"] ?? ""}`);
});

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  saved.clear();
  rmSync(root, { recursive: true, force: true });
});

describe("land", () => {
  test("rebases the branch on a dev that moved and pushes it to dev and to its own ref", () => {
    const moved = moveDev();

    serve(pullRequest());

    const landing = land("feature/x", work);
    const head = git(work, "rev-parse", "HEAD");

    expect(landing).toEqual({ kind: "landed", dev: head, pr: 7 });
    expect(git(origin, "rev-parse", "dev")).toBe(head);
    expect(git(origin, "rev-parse", "feature/x")).toBe(head);
    expect(git(work, "rev-parse", "HEAD~1")).toBe(moved);
  });

  test("finds the checkout holding the branch from another checkout", () => {
    git(work, "switch", "--quiet", "dev");
    git(work, "worktree", "add", "--quiet", join(root, "wt"), "feature/x");
    serve(pullRequest({ headRefOid: git(join(root, "wt"), "rev-parse", "HEAD") }));

    expect(land("feature/x", work).kind).toBe("landed");
    expect(git(origin, "rev-parse", "dev")).toBe(git(join(root, "wt"), "rev-parse", "HEAD"));
  });

  test("lands with an untracked file in the checkout", () => {
    serve(pullRequest());
    writeFileSync(join(work, "scratch.log"), "notes\n");

    expect(land("feature/x", work).kind).toBe("landed");
  });

  test.each([
    ["a red check", { checks: [{ ...green(), state: "FAILURE" }] }, "not green"],
    ["a check still running", { checks: [{ ...green(), state: "IN_PROGRESS" }] }, "still running"],
    ["no check yet", { checks: [] }, "no check reported"],
    ["a base other than dev", { baseRefName: "feature/base" }, "gh stack"],
    ["a closed pull request", { state: "MERGED" }, "not open"],
    ["a head the pull request does not have", { headRefOid: "0".repeat(40) }, "push it"],
  ] as const)("refuses %s and leaves dev unmoved", (_, overrides, reason) => {
    const before = git(origin, "rev-parse", "dev");

    serve(pullRequest(overrides));

    const landing = land("feature/x", work);

    expect(why(landing)).toContain(reason);
    expect(git(origin, "rev-parse", "dev")).toBe(before);
  });

  test("never overwrites a commit pushed to the branch since the pull request was read", () => {
    serve(pullRequest());

    const reviewed = git(work, "rev-parse", "HEAD");

    git(other, "fetch", "--quiet", "origin");
    git(other, "switch", "--quiet", "feature/x");
    const foreign = commit(other, "d.txt", "fixup from someone else");

    git(other, "push", "--quiet", "origin", "feature/x");
    moveDev();

    const landing = land("feature/x", work);

    expect(why(landing)).toContain("the push of feature/x was refused");
    expect(git(origin, "rev-parse", "feature/x")).toBe(foreign);
    expect(git(work, "rev-parse", "HEAD")).toBe(reviewed);
  });

  test("stops after the branch push when a rebase gives an e2e branch a commit its run never saw", () => {
    commit(work, "vellum/src/page.ts", "touch an e2e path");
    git(work, "push", "--quiet", "origin", "feature/x");
    const moved = moveDev();

    serve(pullRequest());

    const landing = land("feature/x", work);

    expect(why(landing)).toContain("--add-label e2e");
    expect(git(origin, "rev-parse", "feature/x")).toBe(git(work, "rev-parse", "HEAD"));
    expect(git(origin, "rev-parse", "dev")).toBe(moved);
  });

  test("refuses tracked changes in the checkout", () => {
    serve(pullRequest());
    writeFileSync(join(work, "b.txt"), "dirty\n");

    expect(land("feature/x", work)).toEqual({
      kind: "refused",
      why: `${work} has uncommitted changes: commit or drop them, then land`,
    });
  });

  test("refuses output gh did not print as a pull request", () => {
    writeFileSync(prFile, "not json");

    expect(why(land("feature/x", work))).toContain("gh printed no pull request");
  });

  test("refuses a branch outside feature/ and fix/, dev and main included", () => {
    for (const branch of ["dev", "main", "chore/x"]) {
      expect(land(branch, work).kind).toBe("refused");
    }
  });

  test("refuses a branch no checkout holds", () => {
    expect(land("fix/nowhere", work)).toEqual({
      kind: "refused",
      why: "no checkout holds fix/nowhere: check it out, then land",
    });
  });
});

describe("checkoutOf", () => {
  test("reads the path of the worktree whose branch matches", () => {
    const porcelain = [
      "worktree /repo\nHEAD 1111\nbranch refs/heads/dev",
      "worktree /repo/.claude/worktrees/a\nHEAD 2222\nbranch refs/heads/feature/x",
      "worktree /repo/.claude/worktrees/b\nHEAD 3333\ndetached",
    ].join("\n\n");

    expect(checkoutOf(porcelain, "feature/x")).toBe("/repo/.claude/worktrees/a");
    expect(checkoutOf(porcelain, "feature")).toBeNull();
  });
});

describe("latestChecks", () => {
  test("keeps the newest attempt of each check", () => {
    const failed = { name: "e2e", startedAt: "2026-10-15T10:00:00Z", state: "FAILURE" };
    const rerun = { name: "e2e", startedAt: "2026-10-15T11:00:00Z", state: "SUCCESS" };

    expect(latestChecks([rerun, failed, green()])).toEqual([rerun, green()]);
  });
});

describe("refusalOf", () => {
  const open: PullRequest = {
    number: 1,
    state: "OPEN",
    baseRefName: "dev",
    headRefOid: "abc",
    checks: [green(), { ...green("e2e"), state: "SKIPPED" }],
  };

  test("lets a green, open pull request against dev through", () => {
    expect(refusalOf("feature/x", open, "abc")).toBeNull();
  });

  test("names every red check", () => {
    const red = {
      ...open,
      checks: [
        { ...green(), state: "FAILURE" },
        { ...green("win32 (scoped)"), state: "CANCELLED" },
      ],
    };

    expect(refusalOf("feature/x", red, "abc")).toBe(
      "checks not green on #1: validate (scoped) failure, win32 (scoped) cancelled",
    );
  });
});

describe("movedOn", () => {
  test("tells a dev that moved from a hook or a rule that refused", () => {
    expect(movedOn(" ! [rejected]        feature/x -> dev (fetch first)")).toBe(true);
    expect(movedOn(" ! [rejected]        feature/x -> dev (non-fast-forward)")).toBe(true);
    expect(movedOn("error: failed to push some refs\npre-push hook exited with code 1")).toBe(
      false,
    );
    expect(
      movedOn(
        " ! [remote rejected] feature/x -> dev (push declined due to repository rule violations)",
      ),
    ).toBe(false);
  });
});
