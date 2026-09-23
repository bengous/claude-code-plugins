import { describe, expect, test } from "bun:test";

import {
  type LinkedWorktree,
  parseWorktreeList,
  type Registration,
  type TriageContext,
  triageWorktree,
  type WorktreeHead,
} from "./worktrees.ts";

const OID = "d27879e5ee2ee7b9b1b9283476e6349e4d9e665d";

const ZERO = "0".repeat(40);

const MAIN = `worktree /repo\nHEAD ${OID}\nbranch refs/heads/main`;

const listOf = (...blocks: string[]) => `${[MAIN, ...blocks].join("\n\n")}\n`;

const parsedOne = (block: string): LinkedWorktree => {
  const parsed = parseWorktreeList(listOf(block));

  if ("error" in parsed) throw new Error(parsed.error);
  expect(parsed).toHaveLength(1);

  return parsed[0]!;
};

describe("parseWorktreeList", () => {
  test("skips the main worktree", () => {
    expect(parseWorktreeList(listOf())).toEqual([]);
  });

  test("reads a branch, a detached HEAD and a branch with no commit", () => {
    expect(parsedOne(`worktree /wt\nHEAD ${OID}\nbranch refs/heads/feature/a`).head).toEqual({
      kind: "branch",
      branch: "feature/a",
    });
    expect(parsedOne(`worktree /wt\nHEAD ${OID}\ndetached`).head).toEqual({ kind: "detached" });
    expect(parsedOne(`worktree /wt\nHEAD ${ZERO}\nbranch refs/heads/gone`).head).toEqual({
      kind: "unborn",
      branch: "gone",
    });
  });

  test("reads a lock and a prune with or without their reason", () => {
    const base = `worktree /wt\nHEAD ${OID}\ndetached`;

    expect(parsedOne(base).registration).toEqual({ kind: "active" });
    expect(parsedOne(`${base}\nlocked`).registration).toEqual({ kind: "locked", reason: null });
    expect(parsedOne(`${base}\nlocked claude plugin catalog`).registration).toEqual({
      kind: "locked",
      reason: "claude plugin catalog",
    });
    expect(
      parsedOne(`${base}\nprunable gitdir file points to non-existent location`).registration,
    ).toEqual({ kind: "prunable", reason: "gitdir file points to non-existent location" });
  });

  test("keeps a path that contains spaces", () => {
    expect(parsedOne(`worktree /my wt\nHEAD ${OID}\ndetached`).path).toBe("/my wt");
  });

  test("refuses an entry git cannot produce instead of guessing", () => {
    for (const block of [
      `worktree /wt\nHEAD ${OID}\ndetached\nlocked\nprunable gone`,
      `worktree /wt\nHEAD ${OID}`,
      `worktree /wt\ndetached`,
      `HEAD ${OID}\ndetached`,
    ]) {
      expect(parseWorktreeList(listOf(block))).toHaveProperty("error");
    }
  });
});

const context = (present: boolean): TriageContext => ({
  currentWorktree: "/repo",
  protectedBranches: new Set(["main", "dev"]),
  directoryExists: () => present,
});

const worktree = (head: WorktreeHead, registration: Registration, path = "/wt") => ({
  path,
  head,
  registration,
});

describe("triageWorktree", () => {
  const onBranch: WorktreeHead = { kind: "branch", branch: "feature/a" };
  const locked: Registration = { kind: "locked", reason: "claude plugin catalog" };
  const prunable: Registration = { kind: "prunable", reason: "gitdir file points to nowhere" };
  const active: Registration = { kind: "active" };

  test("keeps a locked worktree whatever its head or directory", () => {
    expect(triageWorktree(worktree({ kind: "detached" }, locked), context(true))).toEqual({
      kind: "kept",
      worktree: {
        path: "/wt",
        branch: null,
        reason: "locked",
        detail: "lock reason: claude plugin catalog",
      },
      hold: null,
    });
    expect(triageWorktree(worktree(onBranch, locked), context(false))).toEqual({
      kind: "kept",
      worktree: {
        path: "/wt",
        branch: "feature/a",
        reason: "locked",
        detail: "directory missing; lock reason: claude plugin catalog",
      },
      hold: { name: "feature/a", reason: "worktree", detail: "/wt (locked)" },
    });
    expect(
      triageWorktree(worktree({ kind: "unborn", branch: "gone" }, locked), context(true)),
    ).toMatchObject({ kind: "kept", hold: null });
  });

  test("proposes a worktree whose directory is gone, and keeps a prunable one still on disk", () => {
    for (const registration of [prunable, active]) {
      expect(triageWorktree(worktree(onBranch, registration), context(false))).toEqual({
        kind: "stale",
        worktree: { path: "/wt", branch: "feature/a" },
      });
    }

    expect(triageWorktree(worktree(onBranch, prunable), context(true))).toEqual({
      kind: "kept",
      worktree: {
        path: "/wt",
        branch: "feature/a",
        reason: "prunable",
        detail: "gitdir file points to nowhere",
      },
      hold: { name: "feature/a", reason: "worktree", detail: "/wt (prunable)" },
    });
  });

  test("keeps a live worktree whose branch has no commit, and skips a detached one", () => {
    expect(
      triageWorktree(worktree({ kind: "unborn", branch: "gone" }, active), context(true)),
    ).toEqual({
      kind: "kept",
      worktree: {
        path: "/wt",
        branch: "gone",
        reason: "unborn",
        detail: "refs/heads/gone has no commit",
      },
      hold: null,
    });
    expect(triageWorktree(worktree({ kind: "detached" }, active), context(true))).toEqual({
      kind: "skipped",
    });
  });

  test("holds the current and the protected worktrees, and inspects the rest", () => {
    expect(triageWorktree(worktree(onBranch, active, "/repo"), context(true))).toEqual({
      kind: "held",
      hold: { name: "feature/a", reason: "worktree", detail: "/repo (current worktree)" },
    });
    expect(
      triageWorktree(worktree({ kind: "branch", branch: "dev" }, active), context(true)),
    ).toEqual({ kind: "held", hold: { name: "dev", reason: "protected", detail: "/wt" } });
    expect(triageWorktree(worktree(onBranch, active), context(true))).toEqual({
      kind: "inspect",
      path: "/wt",
      branch: "feature/a",
    });
  });
});
