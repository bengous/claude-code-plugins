import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseRecord } from "../hooks/findings.ts";
import { run } from "./finding.ts";

const NOW = new Date("2026-10-16T09:30:00.000Z");

const WRAPPER = join(import.meta.dir, "..", "bin", "todos-finding");

let base = "";

let repo = "";

function git(cwd: string, ...args: string[]): void {
  const done = Bun.spawnSync(
    [
      "git",
      "-c",
      "user.email=me@example.com",
      "-c",
      "user.name=Me",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );

  if (done.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${done.stderr.toString()}`);
}

function buffer(): string {
  return join(repo, ".git", "todos", "findings");
}

function recorded(): { readonly id: string; readonly record: ReturnType<typeof parseRecord> }[] {
  return readdirSync(buffer())
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({
      id: name.slice(0, -".json".length),
      record: parseRecord(readFileSync(join(buffer(), name), "utf8")),
    }));
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "todos-finding-")));
  repo = join(base, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "a.ts"), "retry();\n");
  git(base, "init", "--quiet", repo);
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "init");
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("recording", () => {
  test("writes one file per finding into the git common directory, and names its id", () => {
    const outcome = run(["src/a.ts:1", "retries", "forever"], repo, NOW);
    const [only, ...others] = recorded();

    expect(others).toEqual([]);
    expect(only?.record).toEqual({
      path: "src/a.ts",
      line: 1,
      why: "retries forever",
      kind: "finding",
      recordedAt: NOW.toISOString(),
    });
    expect(outcome).toEqual({
      exitCode: 0,
      stdout: `Recorded finding ${only?.id} at src/a.ts:1. The user reviews findings in batch: carry on with your task.\n`,
      stderr: "",
    });
    expect(readdirSync(buffer()).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("keeps a security finding's kind, and names the path from the repository's root", () => {
    expect(
      run(["--security", "a.ts", "prints\n the   token"], join(repo, "src"), NOW).exitCode,
    ).toBe(0);
    expect(
      recorded().map(({ record }) => [record.path, record.line, record.kind, record.why]),
    ).toEqual([["src/a.ts", null, "security", "prints the token"]]);
  });

  test("takes a name that starts with two dots for a path inside", () => {
    writeFileSync(join(repo, "..env"), "TOKEN=x\n");

    expect(run(["..env", "a token in a dotfile"], repo, NOW).exitCode).toBe(0);
    expect(recorded().map(({ record }) => record.path)).toEqual(["..env"]);
  });

  test("records from a linked worktree into the repository's one buffer", () => {
    const worktree = join(base, "worktree");

    git(repo, "worktree", "add", "--quiet", worktree);
    expect(run(["src/a.ts", "seen from a worktree"], worktree, NOW).exitCode).toBe(0);
    expect(recorded().map(({ record }) => record.why)).toEqual(["seen from a worktree"]);
  });

  test.each([
    [["src/missing.ts", "why"], 1, "src/missing.ts: no such file or directory"],
    [["src/a.ts:0", "why"], 1, "src/a.ts:0: lines start at 1"],
    [["../", "why"], 1, "../ is outside the repository"],
    [["src/a.ts"], 2, "say why it matters, after the path"],
    [[], 2, "record a finding, or close one"],
    [["--loud", "src/a.ts", "why"], 2, "unknown option --loud"],
    [["--security"], 2, "name the path the finding is about"],
  ])("refuses %j", (args, exitCode, error) => {
    const outcome = run(args, repo, NOW);

    expect([outcome.exitCode, outcome.stdout]).toEqual([exitCode, ""]);
    expect(outcome.stderr).toContain(error);
  });

  test("refuses a directory outside any git work tree", () => {
    const outcome = run([".", "why"], base, NOW);

    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain(`${base} is not inside a git work tree`);
  });
});

describe("closing", () => {
  test("removes each finding it names and reports an unknown one", () => {
    run(["src/a.ts", "first"], repo, NOW);
    run(["src/a.ts", "second"], repo, NOW);
    const [first, second] = recorded().map(({ id }) => id);
    const closed = run(["--close", first ?? "", "0badc0de"], repo, NOW);

    expect(closed.exitCode).toBe(1);
    expect(closed.stdout).toBe(`Closed finding ${first}.\n`);
    expect(closed.stderr).toBe(`todos-finding: no finding 0badc0de in ${buffer()}\n`);
    expect(recorded().map(({ id }) => id)).toEqual([second ?? ""]);
  });

  test("refuses what is no finding id", () => {
    const outcome = run(["--close", "../../config"], repo, NOW);

    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toContain("not a finding id: ../../config");
  });
});

test("the bin wrapper runs the command", () => {
  const ran = Bun.spawnSync([WRAPPER, "src/a.ts:1", "through the wrapper"], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
  });

  expect([ran.exitCode, ran.stderr.toString()]).toEqual([0, ""]);
  expect(recorded().map(({ record }) => record.why)).toEqual(["through the wrapper"]);
});
