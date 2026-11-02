import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync } from "node:fs";
import path from "node:path";

import type { TempRepo } from "../test-support.ts";
import {
  MINUTE_MS,
  beatAgo,
  createTempRepo,
  git,
  removeTempRepo,
  scrubGitEnv,
  writeConfig,
  writeRepoFile,
} from "../test-support.ts";
import { worktreeLine } from "./worktree.ts";

const PER_TASK = JSON.stringify({
  profile: { worktree: "per-task", landing: { trunk: "dev", release: "main" } },
});

const SESSION = "s1";

let temp: TempRepo;

let main = "";

/** A repository beside `temp.repo` on `main`, its config committed when given; its path with symlinks resolved. */
function makeRepo(name: string, config: string | null): string {
  const repo = path.join(temp.dir, name);
  writeRepoFile(repo, "README.md", "x\n");

  if (config !== null) {
    writeConfig(repo, config);
  }

  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", ".");
  git(repo, "-c", "commit.gpgsign=false", "commit", "-qm", "initial");

  return realpathSync(repo);
}

function lineOf(checkout: string, trunk: string): string {
  return `agent-hooks: another session is live in ${checkout}, and this repository takes one worktree per task: do this task in a worktree of its own, not in this checkout. Create one with git -C ${checkout} worktree add <path> -b <branch> ${trunk}`;
}

function lineFor(command: string, cwd: string): string | null {
  return worktreeLine(command, cwd, SESSION, Date.now());
}

beforeEach(() => {
  scrubGitEnv();
  temp = createTempRepo("agent-hooks-worktree-guard-", { "README.md": "x\n" });
  main = makeRepo("main", PER_TASK);
});

afterEach(() => {
  removeTempRepo(temp);
});

describe("worktreeLine", () => {
  test("git -C <per-task main checkout> commit from another repository, another session live there: one line", () => {
    beatAgo("s2", main, MINUTE_MS);

    expect(lineFor(`git -C ${main} commit -m "fix: x"`, temp.repo)).toBe(lineOf(main, "dev"));
  });

  test("the same with no other session live there: nothing", () => {
    beatAgo("s2", main, 61 * MINUTE_MS);
    beatAgo(SESSION, main, MINUTE_MS);
    beatAgo(`${SESSION}.a1`, main, MINUTE_MS);
    beatAgo("s3", realpathSync(temp.repo), MINUTE_MS);

    expect(lineFor(`git -C ${main} commit -m "fix: x"`, temp.repo)).toBeNull();
  });

  test("cd <path> && git pull: one line", () => {
    beatAgo("s2", main, MINUTE_MS);

    expect(lineFor(`cd ${main} && git pull`, temp.repo)).toBe(lineOf(main, "dev"));
  });

  test("plain git commit with the cwd inside the main checkout, a subdirectory included: one line", () => {
    beatAgo("s2", main, MINUTE_MS);
    mkdirSync(path.join(main, "src"));

    expect(lineFor("git commit -m x", main)).toBe(lineOf(main, "dev"));
    expect(lineFor("git commit -m x", path.join(main, "src"))).toBe(lineOf(main, "dev"));
  });

  test("inside a linked worktree of that checkout: nothing", () => {
    const linked = path.join(temp.dir, "linked");
    git(main, "worktree", "add", "-q", linked, "-b", "feature/x");
    beatAgo("s2", main, MINUTE_MS);
    beatAgo("s2", realpathSync(linked), MINUTE_MS);

    expect(lineFor("git commit -m x", linked)).toBeNull();
    expect(lineFor(`git -C ${linked} pull`, temp.repo)).toBeNull();
  });

  test("a shared repository, declared or by default, and one without the file: nothing", () => {
    beatAgo("s2", main, MINUTE_MS);

    for (const config of [`{ "profile": { "worktree": "shared" } }`, "{}"]) {
      writeConfig(main, config);

      expect(lineFor(`git -C ${main} commit -m x`, temp.repo)).toBeNull();
    }

    const unconfigured = makeRepo("unconfigured", null);
    beatAgo("s2", unconfigured, MINUTE_MS);

    expect(lineFor(`git -C ${unconfigured} commit -m x`, temp.repo)).toBeNull();
  });

  test("git status, git log, and a command that only names git: nothing", () => {
    beatAgo("s2", main, MINUTE_MS);

    for (const command of [
      "git status",
      "git log --oneline -5",
      `git -C ${main} diff`,
      `git -C ${main} push origin dev`,
      "echo git commit",
      "grep -rn 'git checkout' .",
    ]) {
      expect(lineFor(command, main)).toBeNull();
    }
  });

  test("global flags before the subcommand, and any segment of a compound line: one line", () => {
    beatAgo("s2", main, MINUTE_MS);

    for (const command of [
      `git --no-pager -c core.quotepath=off -C ${main} switch dev`,
      `ls && git -C ${main} checkout -b feature/y`,
      `false || git -C ${main} pull --rebase`,
      `echo start; git -C ${main} commit -m x`,
      `echo start\ngit -C ${main} commit -m x`,
    ]) {
      expect(lineFor(command, temp.repo)).toBe(lineOf(main, "dev"));
    }
  });

  test("two commands in one checkout give one line; a relative -C resolves from the cwd", () => {
    beatAgo("s2", main, MINUTE_MS);

    expect(lineFor("git -C main commit -m x && git -C main pull", temp.dir)).toBe(
      lineOf(main, "dev"),
    );
  });

  test("a cd the line cannot follow leaves the command unplaced: nothing", () => {
    beatAgo("s2", main, MINUTE_MS);

    expect(lineFor(`cd "$TARGET" && git commit -m x`, temp.repo)).toBeNull();
  });

  test("without profile.landing, the worktree starts from the checkout's current branch", () => {
    writeConfig(main, `{ "profile": { "worktree": "per-task" } }`);
    git(main, "checkout", "-q", "-b", "topic");
    beatAgo("s2", main, MINUTE_MS);

    expect(lineFor(`git -C ${main} commit -m x`, temp.repo)).toBe(lineOf(main, "topic"));
  });
});
